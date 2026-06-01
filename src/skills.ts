// Built-in chat "skills": leading-slash commands the user can invoke in the
// agent chat (Claude-skills style). Typing "/" at the start of a message opens a
// menu of these; selecting one autocompletes the textarea to a literal "/name "
// prefix that the agent recognizes (see agent.ts system prompt). Data-driven so
// adding a skill is a one-line change here — no new widget per skill.
export interface Skill {
  name: string;
  hint: string;
}

export const SKILLS: Skill[] = [
  { name: "search", hint: "Search across todos, lists, books, and artifacts" },
];
