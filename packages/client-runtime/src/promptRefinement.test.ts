import { PROMPT_REFINEMENT_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canRefinePrompt,
  promptRefinementPhase,
  type PromptRefinementState,
} from "./promptRefinement.ts";

describe("promptRefinementPhase", () => {
  const refining: PromptRefinementState = { kind: "refining", targetKey: "a", draft: "fix it" };
  const refined: PromptRefinementState = {
    kind: "refined",
    targetKey: "a",
    original: "fix it",
    refined: "Fix the bug.",
  };

  it("holds while the draft is untouched", () => {
    expect(promptRefinementPhase(refining, "a", "fix it")).toBe("refining");
    expect(promptRefinementPhase(refined, "a", "Fix the bug.")).toBe("refined");
  });

  it("drops to idle once the draft is edited", () => {
    expect(promptRefinementPhase(refining, "a", "fix it now")).toBe("idle");
    expect(promptRefinementPhase(refined, "a", "Fix the bug. Also")).toBe("idle");
  });

  it("does not follow the composer into another thread", () => {
    expect(promptRefinementPhase(refining, "b", "fix it")).toBe("idle");
    expect(promptRefinementPhase(refined, "b", "Fix the bug.")).toBe("idle");
  });
});

describe("canRefinePrompt", () => {
  it("needs prose beyond attached context", () => {
    expect(canRefinePrompt("fix it")).toBe(true);
    expect(canRefinePrompt("   ")).toBe(false);
    expect(canRefinePrompt("[notes.md](t3-context://v1/file/file_notes)")).toBe(false);
  });

  it("leaves drafts the server would reject alone", () => {
    expect(canRefinePrompt("a".repeat(PROMPT_REFINEMENT_MAX_INPUT_CHARS))).toBe(true);
    expect(canRefinePrompt("a".repeat(PROMPT_REFINEMENT_MAX_INPUT_CHARS + 1))).toBe(false);
  });
});
