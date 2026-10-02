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
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  ZoomIn,
  ZoomOut,
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

const BUTTON_ENTERING = ZoomIn.duration(220)
  .easing(Easing.out(Easing.back(1.8)))
  .reduceMotion(ReduceMotion.System);
const BUTTON_EXITING = ZoomOut.duration(140).reduceMotion(ReduceMotion.System);

/** Sits beside the send button; one control for refine, cancel, and restore. */
export function ComposerRefineButton(props: {
  readonly control: PromptRefinementControl;
  readonly disabled?: boolean;
}) {
  const { control } = props;
  if (!control.visible) return null;
  const disabled = control.disabled || props.disabled === true;
  return (
    <Animated.View entering={BUTTON_ENTERING} exiting={BUTTON_EXITING}>
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
    </Animated.View>
  );
}

const FLOAT_TIMING = { duration: 320, reduceMotion: ReduceMotion.System } as const;

/**
 * Style for the view holding the prompt editor. The draft greys out while the
 * model rewrites it, then the rewrite floats up into place.
 */
export function useRefiningPromptStyle(phase: PromptRefinementPhase) {
  const opacity = useSharedValue(1);
  const translateY = useSharedValue(0);
  useEffect(() => {
    if (phase === "refining") {
      opacity.set(withTiming(0.45, FLOAT_TIMING));
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

const SHINE_WIDTH_PERCENT = 36;

/**
 * A soft band that sweeps left to right over the greyed draft while it is
 * being rewritten. Render it inside the view styled by `useRefiningPromptStyle`.
 * It runs on the UI thread and only while refining.
 */
export function RefiningPromptShine(props: { readonly phase: PromptRefinementPhase }) {
  const refining = props.phase === "refining";
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!refining) return;
    progress.set(0);
    progress.set(
      withRepeat(
        withTiming(1, {
          duration: 1500,
          easing: Easing.inOut(Easing.quad),
          reduceMotion: ReduceMotion.System,
        }),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [progress, refining]);
  const bandStyle = useAnimatedStyle(() => ({
    left: `${progress.get() * (100 + SHINE_WIDTH_PERCENT) - SHINE_WIDTH_PERCENT}%`,
  }));
  if (!refining) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      className="absolute inset-0 overflow-hidden"
    >
      {/* Three strips step the band's strength, standing in for a gradient. */}
      <Animated.View
        className="absolute inset-y-0 flex-row"
        style={[{ width: `${SHINE_WIDTH_PERCENT}%` }, bandStyle]}
      >
        <View className="flex-1 bg-foreground/10" />
        <View className="flex-1 bg-foreground/25" />
        <View className="flex-1 bg-foreground/10" />
      </Animated.View>
    </View>
  );
}
