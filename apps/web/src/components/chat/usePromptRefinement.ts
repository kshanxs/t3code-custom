import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  promptRefinementPhase,
  type PromptRefinementPhase,
  type PromptRefinementState,
} from "@t3tools/client-runtime/prompt-refinement";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * The composer's "Refine prompt" action: rewrite the draft with the text
 * generation model, swap the result in, and offer the original back until the
 * user edits it. `toggle` starts, cancels, or undoes depending on the phase.
 */
export function usePromptRefinement(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  targetKey: string;
  prompt: string;
  promptRef: RefObject<string>;
  replacePrompt: (prompt: string) => void;
}): { phase: PromptRefinementPhase; toggle: () => void } {
  const { environmentId, projectId, targetKey, prompt, promptRef, replacePrompt } = input;
  const refinePrompt = useAtomCommand(serverEnvironment.refinePrompt, { reportFailure: false });
  const [state, setState] = useState<PromptRefinementState | null>(null);
  // Read by the request's completion, which outlives the render that started it.
  const stateRef = useRef(state);
  const targetKeyRef = useRef(targetKey);
  useEffect(() => {
    stateRef.current = state;
    targetKeyRef.current = targetKey;
  }, [state, targetKey]);
  const phase = promptRefinementPhase(state, targetKey, prompt);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    const currentPhase = promptRefinementPhase(current, targetKey, promptRef.current);
    if (currentPhase === "refining") {
      setState(null);
      return;
    }
    if (currentPhase === "refined" && current?.kind === "refined") {
      setState(null);
      replacePrompt(current.original);
      return;
    }

    const draft = promptRef.current;
    const request: PromptRefinementState = { kind: "refining", targetKey, draft };
    stateRef.current = request;
    setState(request);
    void refinePrompt({
      environmentId,
      input: { prompt: draft, ...(projectId ? { projectId } : {}) },
    }).then((result) => {
      // Cancelled, edited, or the composer moved to another thread: the result has no home.
      if (
        stateRef.current !== request ||
        promptRefinementPhase(request, targetKeyRef.current, promptRef.current) !== "refining"
      ) {
        return;
      }
      if (result._tag === "Failure") {
        setState(null);
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not refine the prompt",
          description:
            typeof error === "object" &&
            error !== null &&
            "detail" in error &&
            typeof error.detail === "string"
              ? error.detail
              : "An error occurred.",
        });
        return;
      }
      const refined = result.value.prompt;
      setState({ kind: "refined", targetKey, original: draft, refined });
      replacePrompt(refined);
    });
  }, [environmentId, projectId, promptRef, refinePrompt, replacePrompt, targetKey]);

  return { phase, toggle };
}
