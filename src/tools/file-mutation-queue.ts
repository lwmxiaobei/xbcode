import { realpath } from "node:fs/promises";
import path from "node:path";

// 同一个文件的写操作必须串行，不同文件之间仍然并行。
//
// 为什么需要它：工具调用一旦并行化（多个 edit_file / write_file 同轮下发），
// 两次「读-改-写」就会交错，后写的那次覆盖掉前一次的结果，且没有任何报错。
// 这里按文件建队列，把并发写压成串行，是工具并行化的前置条件。
const fileMutationQueues = new Map<string, Promise<void>>();

// 队列注册本身也要串行：getMutationQueueKey 里有 await，
// 两个并发调用可能同时读到「队列不存在」，各自建一条链，串行保证就没了。
let registrationQueue: Promise<void> = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

// 用 realpath 做 key：符号链接指向同一文件时也要落到同一条队列上。
// 文件还不存在（write 新建）时 realpath 会失败，此时退回普通绝对路径。
async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolved;
    }
    throw error;
  }
}

/**
 * 把针对同一个文件的变更操作串行化，不同文件的操作互不阻塞。
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    // 只有当队尾还是自己时才清理，否则会把后来者的队列一起删掉。
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
