import {
  canRefinePrompt,
  promptRefinementPhase,
  type PromptRefinementPhase,
  type PromptRefinementState,
} from "@t3tools/client-runtime/prompt-refinement";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ServerConfig } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable } from "react-native";
import {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const LABELS: Record<PromptRefinementPhase, string> = {
  idle: "Refine prompt",
  refining: "Cancel refining",
  refined: "Restore original prompt",
};

export interface PromptRefinementControl {
  /** False when the environment turned the feature off, predates it, or the draft has no prose. */
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly phase: PromptRefinementPhase;
  readonly toggle: () => void;
}

/**
 * The composer's "Refine prompt" action: rewrite the draft with the
 * environment's text generation model, swap the result in, and offer the
 * original back until the user edits it. `toggle` starts, cancels, or undoes
 * depending on the phase.
 */
export function usePromptRefinement(input: {
  readonly serverConfig: ServerConfig | null;
  /** Null until the new-task flow has a project, and with it an environment. */
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly targetKey: string;
  readonly prompt: string;
  readonly onChangePrompt: (prompt: string) => void;
}): PromptRefinementControl {
  const { serverConfig, environmentId, projectId, targetKey, prompt, onChangePrompt } = input;
  const refinePrompt = useAtomCommand(serverEnvironment.refinePrompt, { reportFailure: false });
  const [state, setState] = useState<PromptRefinementState | null>(null);
  // Read by the request's completion, which outlives the render that started it.
  const stateRef = useRef(state);
  const latestRef = useRef({ targetKey, prompt });
  useEffect(() => {
    stateRef.current = state;
    latestRef.current = { targetKey, prompt };
  }, [prompt, state, targetKey]);
  const phase = promptRefinementPhase(state, targetKey, prompt);

  const toggle = useCallback(() => {
    const current = stateRef.current;
    const latest = latestRef.current;
    const currentPhase = promptRefinementPhase(current, latest.targetKey, latest.prompt);
    if (currentPhase === "refining") {
      setState(null);
      return;
    }
    if (currentPhase === "refined" && current?.kind === "refined") {
      setState(null);
      onChangePrompt(current.original);
      return;
    }

    if (environmentId === null) return;
    const draft = latest.prompt;
    const request: PromptRefinementState = {
      kind: "refining",
      targetKey: latest.targetKey,
      draft,
    };
    stateRef.current = request;
    setState(request);
    void refinePrompt({
      environmentId,
      input: { prompt: draft, ...(projectId ? { projectId } : {}) },
    }).then((result) => {
      // Cancelled, edited, or the composer moved to another thread: the result has no home.
      if (
        stateRef.current !== request ||
        promptRefinementPhase(request, latestRef.current.targetKey, latestRef.current.prompt) !==
          "refining"
      ) {
        return;
      }
      if (result._tag === "Failure") {
        setState(null);
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not refine the prompt",
          typeof error === "object" &&
            error !== null &&
            "detail" in error &&
            typeof error.detail === "string"
            ? error.detail
            : "An error occurred.",
        );
        return;
      }
      const refined = result.value.prompt;
      setState({ kind: "refined", targetKey: request.targetKey, original: draft, refined });
      onChangePrompt(refined);
    });
  }, [environmentId, onChangePrompt, projectId, refinePrompt]);

  return {
    visible:
      environmentId !== null &&
      serverConfig?.environment.capabilities.promptRefinement === true &&
      serverConfig.settings.enablePromptRefinement &&
      prompt.trim().length > 0,
    disabled: phase === "idle" && !canRefinePrompt(prompt),
    phase,
    toggle,
  };
}

/** Sits beside the send button; one control for refine, cancel, and restore. */
export function ComposerRefineButton(props: {
  readonly control: PromptRefinementControl;
  readonly disabled?: boolean;
}) {
  const { control } = props;
  if (!control.visible) return null;
  const disabled = control.disabled || props.disabled === true;
  return (
    <Pressable
      accessibilityLabel={LABELS[control.phase]}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: control.phase === "refining" }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={disabled}
      onPress={control.toggle}
    >
      {control.phase === "refining" ? (
        <ActivityIndicator size="small" />
      ) : (
        <SymbolView
          name={
            control.phase === "refined"
              ? "arrow.uturn.backward"
              : { ios: "wand.and.stars", android: "auto_awesome" }
          }
          size={18}
          weight="medium"
          tintColorClassName={disabled ? "accent-icon-subtle" : "accent-icon"}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

const FLOAT_TIMING = { duration: 320, reduceMotion: ReduceMotion.System } as const;

/**
 * Style for the view holding the prompt editor. The draft lifts and dims while
 * the model rewrites it, then the rewrite floats up into place. Each runs once
 * and holds, so nothing animates while the request is in flight.
 */
export function useRefiningPromptStyle(phase: PromptRefinementPhase) {
  const opacity = useSharedValue(1);
  const translateY = useSharedValue(0);
  useEffect(() => {
    if (phase === "refining") {
      opacity.set(withTiming(0.5, FLOAT_TIMING));
      translateY.set(withTiming(-6, FLOAT_TIMING));
      return;
    }
    if (phase === "refined") {
      opacity.set(0);
      translateY.set(10);
    }
    opacity.set(withTiming(1, FLOAT_TIMING));
    translateY.set(withTiming(0, FLOAT_TIMING));
  }, [opacity, phase, translateY]);
  return useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ translateY: translateY.get() }],
  }));
}
