export type SkillFrontmatter = {
  name?: string;
  description?: string;
  tags?: string;
  when_to_use?: string;
  "allowed-tools"?: string | string[];
  "argument-hint"?: string;
};

export type SkillDescriptor = {
  name: string;
  description: string;
  tags?: string;
  whenToUse?: string;
  allowedTools: string[];
  argumentHint?: string;
  body: string;
  filePath: string;
  baseDir?: string;
};

export type PromptCommand = {
  name: string;
  description: string;
  tags?: string;
  whenToUse?: string;
  allowedTools: string[];
  argumentHint?: string;
  content: string;
  filePath: string;
  baseDir?: string;
  source: "skill";
};
