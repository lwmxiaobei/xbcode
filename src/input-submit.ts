export type SubmitDeduper = {
  /**
   * 在极短时间窗口内，只允许同一份输入通过一次。
   * 这样既能让外层键盘监听兜底处理 Enter，也不会和 TextInput 的 onSubmit 重复提交。
   */
  shouldSubmit(value: string): boolean;
};

/**
 * 从一次输入事件中提取“应当立即提交”的文本。
 * 正常终端会把 Enter 解析成 `key.return`，但有些环境会把整行内容连同换行一起塞进 `input`。
 * 这里统一把两种情况折叠成同一种提交值，避免 `/exit` 之类的命令只进入输入框而不执行。
 */
export function getSubmittedValueFromInput(currentValue: string, input: string, keyReturn: boolean): string | null {
  if (keyReturn) {
    return currentValue;
  }

  const firstLineBreak = input.search(/[\r\n]/);
  if (firstLineBreak === -1) {
    return null;
  }

  return currentValue + input.slice(0, firstLineBreak);
}

/**
 * 某些终端下，普通字符会正常进入输入框，但 Enter 不一定稳定触发 TextInput 的 onSubmit。
 * 这里提供一个非常小的去重器，允许我们在父级 useInput 中补一层 Enter 处理，
 * 同时避免一次按键触发两次提交。
 */
export function createSubmitDeduper(windowMs = 80): SubmitDeduper {
  let lastValue = "";
  let lastAt = 0;

  return {
    shouldSubmit(value: string): boolean {
      const now = Date.now();
      const isDuplicate = value === lastValue && now - lastAt <= windowMs;

      lastValue = value;
      lastAt = now;

      return !isDuplicate;
    },
  };
}
