import type { SkillDefinition } from "../../types/index.js";
import { parseNameDescriptionFrontmatter } from "../frontmatter.js";

export const PRIMARY_SKILLS_PROJECT_DIR = [".pi", "skills"];
export const PRIMARY_SKILL_FILE = "SKILL.md";

export function parseSkillFrontmatter(content: string): Omit<SkillDefinition, "location"> | null {
  const parsed = parseNameDescriptionFrontmatter(content);
  if (!parsed) return null;
  return parsed;
}
