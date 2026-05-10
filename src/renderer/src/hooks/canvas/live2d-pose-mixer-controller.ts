import {
  getDefaultLive2DParameterProfile,
  Live2DParameterApplyMode,
  Live2DParameterProfile,
} from '@/live2d/mixer/live2d-parameter-profile';
import { LogicalChannel, PoseValues } from '@/live2d/mixer/logical-channels';
import { IdleBankConfig, IdlePlayCommand, RecordedIdleDriver } from '@/live2d/mixer/recorded-idle-driver';
import { Mixer, PoseLayer } from '@/live2d/mixer/pose-mixer';

interface PatchedModel {
  _poseMixerController?: {
    controller: Live2DPoseMixerController;
    originalUpdate: () => void;
  };
  setDragging?: (x: number, y: number) => void;
  _model?: {
    addParameterValueById: (id: unknown, value: number, weight?: number) => void;
    setParameterValueById: (id: unknown, value: number, weight?: number) => void;
    update: () => void;
  };
  update: () => void;
}

export type PoseLayerId = 'idle_layer' | 'speech_layer' | 'backend_pose_layer' | 'mouse_attention_layer';

interface LayerState {
  weight: number;
  values: PoseValues;
  weightTransition: WeightTransition | null;
}

interface WeightTransition {
  fromWeight: number;
  toWeight: number;
  startTimeMs: number;
  durationMs: number;
}

interface ScalarTransition {
  fromValue: number;
  toValue: number;
  startTimeMs: number;
  durationMs: number;
}

const DEFAULT_LAYER_WEIGHTS: Record<PoseLayerId, number> = {
  idle_layer: 1,
  speech_layer: 1,
  backend_pose_layer: 1,
  mouse_attention_layer: 0.35,
};

const ORIENTATION_CHANNELS: LogicalChannel[] = [
  'head_yaw',
  'head_pitch',
  'head_roll',
  'body_yaw',
  'body_pitch',
  'body_roll',
  'gaze_x',
  'gaze_y',
];

const LAYER_WEIGHT_TRANSITION_MS = 960;
const IDLE_MOUTH_BLEND_TRANSITION_MS = 640;
const CHANNEL_RELEASE_EPSILON = 0.01;

const CHANNEL_NEUTRAL_VALUES: Record<LogicalChannel, number> = {
  head_yaw: 0,
  head_pitch: 0,
  head_roll: 0,
  body_yaw: 0,
  body_pitch: 0,
  body_roll: 0,
  gaze_x: 0,
  gaze_y: 0,
  eye_l_open: 1,
  eye_r_open: 1,
  brow_raise: 0,
  mouth_open: 0,
  mouth_form: 0,
};

const CHANNEL_TRANSITION_MS: Record<LogicalChannel, number> = {
  head_yaw: 360,
  head_pitch: 360,
  head_roll: 360,
  body_yaw: 520,
  body_pitch: 520,
  body_roll: 520,
  gaze_x: 240,
  gaze_y: 240,
  eye_l_open: 220,
  eye_r_open: 220,
  brow_raise: 360,
  mouth_open: 180,
  mouth_form: 240,
};

const CHANNEL_RELEASE_MS: Record<LogicalChannel, number> = {
  head_yaw: 440,
  head_pitch: 440,
  head_roll: 440,
  body_yaw: 600,
  body_pitch: 600,
  body_roll: 600,
  gaze_x: 300,
  gaze_y: 300,
  eye_l_open: 240,
  eye_r_open: 240,
  brow_raise: 360,
  mouth_open: 220,
  mouth_form: 300,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function easeInOutCubic(alpha: number): number {
  if (alpha <= 0) {
    return 0;
  }
  if (alpha >= 1) {
    return 1;
  }
  if (alpha < 0.5) {
    return 4 * alpha * alpha * alpha;
  }
  return 1 - ((-2 * alpha + 2) ** 3) / 2;
}

function sanitizeChannelValue(channel: LogicalChannel, value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (channel === 'mouth_open' || channel === 'eye_l_open' || channel === 'eye_r_open') {
    return clamp(value, 0, 1);
  }

  if (channel === 'mouth_form') {
    return clamp(value, -1, 1);
  }

  if (channel === 'body_yaw' || channel === 'body_pitch' || channel === 'body_roll') {
    // Recorded idle clips can exceed the nominal [-1, 1] range on body channels.
    // Keep a wider safety band so large torso motion is preserved.
    return clamp(value, -2, 2);
  }

  return clamp(value, -1, 1);
}

function isEmptyPose(values: PoseValues): boolean {
  return Object.keys(values).length === 0;
}

export class Live2DPoseMixerController {
  private readonly mixer = new Mixer({
    preferredChannels: {
      eye_l_open: ['idle_layer'],
      eye_r_open: ['idle_layer'],
      brow_raise: ['idle_layer'],
      mouth_open: ['speech_layer', 'idle_layer'],
      mouth_form: ['speech_layer', 'idle_layer'],
    },
  });

  private profile: Live2DParameterProfile = getDefaultLive2DParameterProfile();

  private modelUrl?: string;

  private idleState: string = 'listening';

  private idleMouthEnabled = true;

  private idleMouthBlend = 1;

  private idleMouthBlendTransition: ScalarTransition | null = null;

  private layers: Record<PoseLayerId, LayerState> = {
    idle_layer: { weight: DEFAULT_LAYER_WEIGHTS.idle_layer, values: {}, weightTransition: null },
    speech_layer: { weight: DEFAULT_LAYER_WEIGHTS.speech_layer, values: {}, weightTransition: null },
    backend_pose_layer: { weight: DEFAULT_LAYER_WEIGHTS.backend_pose_layer, values: {}, weightTransition: null },
    mouse_attention_layer: { weight: DEFAULT_LAYER_WEIGHTS.mouse_attention_layer, values: {}, weightTransition: null },
  };

  private readonly recordedIdleDriver = new RecordedIdleDriver((pose) => {
    this.setIdlePose(pose);
  });

  private lastFinalPose: PoseValues = {};

  private lastAppliedPose: PoseValues = {};

  private lastPoseSmoothingTimeMs: number | null = null;

  private getMouseAttentionDragInput(): { x: number; y: number } {
    const nowMs = performance.now();
    const layer = this.layers.mouse_attention_layer;
    const layerWeight = this.getResolvedLayerWeight('mouse_attention_layer', nowMs);
    if (!layer || typeof layerWeight !== 'number' || !Number.isFinite(layerWeight) || layerWeight <= 0) {
      return { x: 0, y: 0 };
    }

    const values = layer.values ?? {};
    const rawX = [values.gaze_x, values.head_yaw, values.body_yaw]
      .find((value) => typeof value === 'number' && Number.isFinite(value));
    const rawY = [values.gaze_y, values.head_pitch]
      .find((value) => typeof value === 'number' && Number.isFinite(value));

    // Respect mixer weight amplitude for drag compatibility path:
    // - weight = 0   => no mouse-attention drag
    // - weight = 0.5 => half-strength drag
    // - weight = 1   => full-strength drag
    const x = typeof rawX === 'number' ? clamp(rawX * layerWeight, -1, 1) : 0;
    const y = typeof rawY === 'number' ? clamp(rawY * layerWeight, -1, 1) : 0;
    return { x, y };
  }

  /**
   * Replace the entire pose for a layer (partial poses are allowed).
   */
  public setLayerPose(layerId: PoseLayerId, values: PoseValues, weight?: number): void {
    this.layers[layerId] = {
      weight: this.layers[layerId].weight,
      values: { ...values },
      weightTransition: this.layers[layerId].weightTransition,
    };
    if (typeof weight === 'number' && Number.isFinite(weight)) {
      this.transitionLayerWeight(layerId, weight);
      return;
    }
    this.refreshFinalPoseSnapshot();
  }

  /**
   * Merge a partial pose into an existing layer.
   * Useful for backends that stream only changed channels.
   */
  public patchLayerPose(layerId: PoseLayerId, values: PoseValues, weight?: number): void {
    this.layers[layerId] = {
      weight: this.layers[layerId].weight,
      values: { ...this.layers[layerId].values, ...values },
      weightTransition: this.layers[layerId].weightTransition,
    };
    if (typeof weight === 'number' && Number.isFinite(weight)) {
      this.transitionLayerWeight(layerId, weight);
      return;
    }
    this.refreshFinalPoseSnapshot();
  }

  public clearLayerPose(layerId: PoseLayerId): void {
    this.layers[layerId] = {
      ...this.layers[layerId],
      values: {},
    };
    this.refreshFinalPoseSnapshot();
  }

  public setBackendPose(values: PoseValues, weight?: number): void {
    this.setLayerPose('backend_pose_layer', values, weight);
  }

  public patchBackendPose(values: PoseValues, weight?: number): void {
    this.patchLayerPose('backend_pose_layer', values, weight);
  }

  public clearBackendPose(): void {
    this.clearLayerPose('backend_pose_layer');
  }

  public setMouseAttentionPose(values: PoseValues, weight?: number): void {
    this.setLayerPose('mouse_attention_layer', values, weight);
  }

  public clearMouseAttention(): void {
    this.clearLayerPose('mouse_attention_layer');
  }

  public setLayerWeight(layerId: PoseLayerId, weight: number): void {
    if (!Number.isFinite(weight) || weight < 0) {
      return;
    }
    this.transitionLayerWeight(layerId, weight);
  }

  public patchLayerWeights(weights: Partial<Record<PoseLayerId, number>>): void {
    let changed = false;
    (Object.keys(weights) as PoseLayerId[]).forEach((layerId) => {
      const weight = weights[layerId];
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
        return;
      }
      this.transitionLayerWeight(layerId, weight, false);
      changed = true;
    });

    if (changed) {
      this.refreshFinalPoseSnapshot();
    }
  }

  public resetLayerWeights(): void {
    (Object.keys(DEFAULT_LAYER_WEIGHTS) as PoseLayerId[]).forEach((layerId) => {
      this.transitionLayerWeight(layerId, DEFAULT_LAYER_WEIGHTS[layerId], false);
    });
    this.refreshFinalPoseSnapshot();
  }

  public setSpeechMouthOpen(mouthOpen: number, weight?: number): void {
    this.patchLayerPose('speech_layer', { mouth_open: mouthOpen }, weight);
  }

  public clearSpeech(): void {
    this.clearLayerPose('speech_layer');
  }

  public setIdlePose(values: PoseValues, weight?: number): void {
    this.setLayerPose('idle_layer', values, weight);
  }

  public clearIdlePose(): void {
    this.clearLayerPose('idle_layer');
  }

  public setProfile(profile: Live2DParameterProfile): void {
    this.profile = profile;
    this.refreshFinalPoseSnapshot();
  }

  public setModelUrl(modelUrl?: string): void {
    if (this.modelUrl === modelUrl) {
      return;
    }

    this.modelUrl = modelUrl;
    this.lastAppliedPose = {};
    this.lastPoseSmoothingTimeMs = null;
    this.recordedIdleDriver.setModelUrl(modelUrl);
  }

  public setIdleRuntimeState(state?: string | null): void {
    const normalizedState = typeof state === 'string' ? state.trim().toLowerCase() : '';
    if (normalizedState) {
      this.idleState = normalizedState;
    }

    const shouldEnableIdleMouth = this.idleState !== 'speaking';
    if (this.idleMouthEnabled !== shouldEnableIdleMouth) {
      this.idleMouthEnabled = shouldEnableIdleMouth;
      this.transitionIdleMouthBlend(shouldEnableIdleMouth ? 1 : 0);
      return;
    }

    this.refreshFinalPoseSnapshot();
  }

  public setRecordedIdleBank(bank: IdleBankConfig | null): void {
    this.recordedIdleDriver.setIdleBank(bank);
  }

  public clearRecordedIdleBank(): void {
    this.recordedIdleDriver.clearIdleBank();
  }

  public playRecordedIdleClip(command: IdlePlayCommand | string | null | undefined): void {
    this.recordedIdleDriver.playManualClip(command, performance.now() * 0.001);
  }

  public getRecordedIdleState() {
    return this.recordedIdleDriver.getDebugState();
  }

  public getProfile(): Live2DParameterProfile {
    return this.profile;
  }

  public getLayerStates(): Record<PoseLayerId, LayerState> {
    const nowMs = performance.now();
    return {
      idle_layer: {
        weight: this.getResolvedLayerWeight('idle_layer', nowMs),
        values: { ...this.layers.idle_layer.values },
        weightTransition: this.layers.idle_layer.weightTransition
          ? { ...this.layers.idle_layer.weightTransition }
          : null,
      },
      speech_layer: {
        weight: this.getResolvedLayerWeight('speech_layer', nowMs),
        values: { ...this.layers.speech_layer.values },
        weightTransition: this.layers.speech_layer.weightTransition
          ? { ...this.layers.speech_layer.weightTransition }
          : null,
      },
      backend_pose_layer: {
        weight: this.getResolvedLayerWeight('backend_pose_layer', nowMs),
        values: { ...this.layers.backend_pose_layer.values },
        weightTransition: this.layers.backend_pose_layer.weightTransition
          ? { ...this.layers.backend_pose_layer.weightTransition }
          : null,
      },
      mouse_attention_layer: {
        weight: this.getResolvedLayerWeight('mouse_attention_layer', nowMs),
        values: { ...this.layers.mouse_attention_layer.values },
        weightTransition: this.layers.mouse_attention_layer.weightTransition
          ? { ...this.layers.mouse_attention_layer.weightTransition }
          : null,
      },
    };
  }

  public getFinalMixedPose(): PoseValues {
    return { ...this.lastFinalPose };
  }

  public getDebugState() {
    return {
      modelUrl: this.modelUrl ?? null,
      idleState: this.idleState,
      idleMouthEnabled: this.idleMouthEnabled,
      idleMouthBlend: this.getIdleMouthBlend(performance.now()),
      layers: this.getLayerStates(),
      finalPose: this.getFinalMixedPose(),
      appliedPose: { ...this.lastAppliedPose },
      profile: this.getProfile(),
      recordedIdle: this.getRecordedIdleState(),
    };
  }

  /**
   * Install a post-update runner that applies the mixed pose via Live2D parameter IDs.
   *
   * Ordering note:
   * - This is designed to coexist with the existing expression/motion system.
   * - It runs after the underlying Live2D update (and any other wrappers that were installed earlier).
   */
  public installRunner(lappAdapter: any): boolean {
    const model = lappAdapter?.getModel?.() as PatchedModel | null | undefined;
    if (!model || !model._model || typeof model.update !== 'function') {
      return false;
    }

    const existingRunner = model._poseMixerController;
    if (existingRunner?.controller === this) {
      return true;
    }

    const originalUpdate = existingRunner?.originalUpdate ?? model.update.bind(model);
    model._poseMixerController = {
      controller: this,
      originalUpdate,
    };

    // Disable SDK built-in drag parameter injection; mouse attention is now a mixer layer.
    const manager = (window as any).LAppLive2DManager?.getInstance?.();
    manager?.setDragInputEnabled?.(false);

    model.update = () => {
      const runner = model._poseMixerController;
      const dragInput = this.getMouseAttentionDragInput();
      model.setDragging?.(dragInput.x, dragInput.y);
      runner?.originalUpdate();
      this.recordedIdleDriver.update(performance.now() * 0.001);

      const appliedAnyPose = this.applyMixedPose(model, lappAdapter);
      if (appliedAnyPose) {
        model._model?.update();
      }
    };

    return true;
  }

  public installDebugGlobals(): void {
    const w = window as any;

    const debugApi = {
      setBackendPose: (pose: PoseValues, weight?: number) => this.setBackendPose(pose, weight),
      patchBackendPose: (pose: PoseValues, weight?: number) => this.patchBackendPose(pose, weight),
      clearBackendPose: () => this.clearBackendPose(),
      setMouseAttentionPose: (pose: PoseValues, weight?: number) => this.setMouseAttentionPose(pose, weight),
      clearMouseAttention: () => this.clearMouseAttention(),
      setLayerWeight: (layerId: PoseLayerId, weight: number) => this.setLayerWeight(layerId, weight),
      patchLayerWeights: (weights: Partial<Record<PoseLayerId, number>>) => this.patchLayerWeights(weights),
      resetLayerWeights: () => this.resetLayerWeights(),
      setSpeechMouthOpen: (value: number, weight?: number) => this.setSpeechMouthOpen(value, weight),
      clearSpeech: () => this.clearSpeech(),
      setIdlePose: (pose: PoseValues, weight?: number) => this.setIdlePose(pose, weight),
      clearIdlePose: () => this.clearIdlePose(),
      clearAllLayers: () => {
        this.clearIdlePose();
        this.clearSpeech();
        this.clearBackendPose();
        this.clearMouseAttention();
      },
      getLayers: () => this.getLayerStates(),
      getFinalPose: () => this.getFinalMixedPose(),
      getDebugState: () => this.getDebugState(),
      getRecordedIdleState: () => this.getRecordedIdleState(),
      setRecordedIdleBank: (bank: IdleBankConfig | null) => this.setRecordedIdleBank(bank),
      clearRecordedIdleBank: () => this.clearRecordedIdleBank(),
      playRecordedIdleClip: (command: IdlePlayCommand | string | null | undefined) => this.playRecordedIdleClip(command),
      setIdleRuntimeState: (state?: string | null) => this.setIdleRuntimeState(state),
      inspect: () => {
        const debugState = this.getDebugState();
        console.log('[Live2DPoseMixer] debug state', debugState);
        return debugState;
      },
      getProfile: () => this.getProfile(),
      setProfile: (profile: Live2DParameterProfile) => this.setProfile(profile),
    };

    w.Live2DPoseMixer = debugApi;
    w.Live2DPoseMixerDebug = debugApi;
  }

  private transitionLayerWeight(layerId: PoseLayerId, targetWeight: number, refreshSnapshot: boolean = true): void {
    const nowMs = performance.now();
    const currentWeight = this.getResolvedLayerWeight(layerId, nowMs);
    const normalizedTarget = Math.max(0, targetWeight);
    this.layers[layerId] = {
      ...this.layers[layerId],
      weight: normalizedTarget,
      weightTransition: Math.abs(currentWeight - normalizedTarget) <= 1e-4
        ? null
        : {
          fromWeight: currentWeight,
          toWeight: normalizedTarget,
          startTimeMs: nowMs,
          durationMs: LAYER_WEIGHT_TRANSITION_MS,
        },
    };

    if (refreshSnapshot) {
      this.refreshFinalPoseSnapshot();
    }
  }

  private transitionIdleMouthBlend(targetValue: number): void {
    const nowMs = performance.now();
    const currentValue = this.getIdleMouthBlend(nowMs);
    const normalizedTarget = clamp(targetValue, 0, 1);
    this.idleMouthBlend = normalizedTarget;
    this.idleMouthBlendTransition = Math.abs(currentValue - normalizedTarget) <= 1e-4
      ? null
      : {
        fromValue: currentValue,
        toValue: normalizedTarget,
        startTimeMs: nowMs,
        durationMs: IDLE_MOUTH_BLEND_TRANSITION_MS,
      };
    this.refreshFinalPoseSnapshot();
  }

  private getResolvedTransitionValue(
    fromValue: number,
    toValue: number,
    startTimeMs: number,
    durationMs: number,
    nowMs: number,
  ): number {
    if (durationMs <= 0) {
      return toValue;
    }

    const progress = clamp((nowMs - startTimeMs) / durationMs, 0, 1);
    const alpha = easeInOutCubic(progress);
    return fromValue + (toValue - fromValue) * alpha;
  }

  private getChannelStepAlpha(durationMs: number, dtMs: number): number {
    if (durationMs <= 0) {
      return 1;
    }

    const safeDtMs = clamp(dtMs, 1000 / 240, 120);
    return 1 - Math.exp(-safeDtMs / durationMs);
  }

  private getSmoothedPose(targetPose: PoseValues, nowMs: number): PoseValues {
    const previousPose = this.lastAppliedPose;
    const previousTimeMs = this.lastPoseSmoothingTimeMs;
    this.lastPoseSmoothingTimeMs = nowMs;

    if (previousTimeMs === null) {
      this.lastAppliedPose = { ...targetPose };
      return { ...targetPose };
    }

    const dtMs = Math.max(nowMs - previousTimeMs, 0);
    const nextPose: PoseValues = {};
    const channels = new Set<LogicalChannel>([
      ...(Object.keys(targetPose) as LogicalChannel[]),
      ...(Object.keys(previousPose) as LogicalChannel[]),
    ]);

    channels.forEach((channel) => {
      const targetValue = targetPose[channel];
      const previousValue = previousPose[channel];

      if (typeof targetValue === 'number' && Number.isFinite(targetValue)) {
        if (typeof previousValue !== 'number' || !Number.isFinite(previousValue)) {
          nextPose[channel] = targetValue;
          return;
        }

        const alpha = this.getChannelStepAlpha(CHANNEL_TRANSITION_MS[channel], dtMs);
        nextPose[channel] = previousValue + (targetValue - previousValue) * alpha;
        return;
      }

      if (typeof previousValue !== 'number' || !Number.isFinite(previousValue)) {
        return;
      }

      const neutralValue = CHANNEL_NEUTRAL_VALUES[channel];
      const alpha = this.getChannelStepAlpha(CHANNEL_RELEASE_MS[channel], dtMs);
      const releasedValue = previousValue + (neutralValue - previousValue) * alpha;
      if (Math.abs(releasedValue - neutralValue) > CHANNEL_RELEASE_EPSILON) {
        nextPose[channel] = releasedValue;
      }
    });

    this.lastAppliedPose = nextPose;
    return { ...nextPose };
  }

  private getResolvedLayerWeight(layerId: PoseLayerId, nowMs: number = performance.now()): number {
    const layer = this.layers[layerId];
    const transition = layer.weightTransition;
    if (!transition) {
      return layer.weight;
    }

    const resolvedWeight = this.getResolvedTransitionValue(
      transition.fromWeight,
      transition.toWeight,
      transition.startTimeMs,
      transition.durationMs,
      nowMs,
    );

    if (nowMs - transition.startTimeMs >= transition.durationMs) {
      this.layers[layerId] = {
        ...layer,
        weightTransition: null,
      };
      return transition.toWeight;
    }

    return resolvedWeight;
  }

  private getIdleMouthBlend(nowMs: number = performance.now()): number {
    const transition = this.idleMouthBlendTransition;
    if (!transition) {
      return this.idleMouthBlend;
    }

    const resolvedValue = this.getResolvedTransitionValue(
      transition.fromValue,
      transition.toValue,
      transition.startTimeMs,
      transition.durationMs,
      nowMs,
    );

    if (nowMs - transition.startTimeMs >= transition.durationMs) {
      this.idleMouthBlendTransition = null;
      return transition.toValue;
    }

    return resolvedValue;
  }

  private getActiveLayers(nowMs: number = performance.now()): PoseLayer[] {
    const idleMouthBlend = this.getIdleMouthBlend(nowMs);
    const layers: PoseLayer[] = [
      {
        id: 'idle_layer',
        weight: this.getResolvedLayerWeight('idle_layer', nowMs),
        frame: isEmptyPose(this.layers.idle_layer.values) ? null : { values: this.layers.idle_layer.values },
        // 运行时策略：
        // - listening: 允许 recorded idle 的嘴部曲线参与
        // - speaking: 仅屏蔽 idle 的 mouth_open，mouth_form 继续沿用 recorded idle
        mask: idleMouthBlend >= 0.999
          ? undefined
          : {
            mouth_open: idleMouthBlend,
          },
      },
      {
        id: 'speech_layer',
        weight: this.getResolvedLayerWeight('speech_layer', nowMs),
        frame: isEmptyPose(this.layers.speech_layer.values) ? null : { values: this.layers.speech_layer.values },
      },
      {
        id: 'backend_pose_layer',
        weight: this.getResolvedLayerWeight('backend_pose_layer', nowMs),
        frame: isEmptyPose(this.layers.backend_pose_layer.values) ? null : { values: this.layers.backend_pose_layer.values },
      },
      {
        id: 'mouse_attention_layer',
        weight: this.getResolvedLayerWeight('mouse_attention_layer', nowMs),
        frame: isEmptyPose(this.layers.mouse_attention_layer.values) ? null : { values: this.layers.mouse_attention_layer.values },
      },
    ];

    return layers;
  }

  private refreshFinalPoseSnapshot(): void {
    this.lastFinalPose = this.mixer.apply(this.getActiveLayers(performance.now()));
  }

  private applyParameterByMode(
    model: PatchedModel,
    parameterId: unknown,
    value: number,
    applyMode: Live2DParameterApplyMode,
  ): void {
    if (applyMode === 'add' && model._model?.addParameterValueById) {
      model._model.addParameterValueById(parameterId, value, 1);
      return;
    }

    model._model?.setParameterValueById(parameterId, value, 1);
  }

  private applyMixedPose(model: PatchedModel, lappAdapter: any): boolean {
    const idManager = lappAdapter.getIdManager?.();
    if (!idManager?.getId) {
      return false;
    }

    // Mixer owns long-lived head/eye/body orientation channels.
    // Future drag/mouse-attention/event layers should enter here as additional layers.
    this.refreshFinalPoseSnapshot();
    const finalPose: PoseValues = { ...this.lastFinalPose };

    const nowMs = performance.now();
    const isMouseOnlyMode = this.getResolvedLayerWeight('mouse_attention_layer', nowMs) > 0
      && this.getResolvedLayerWeight('idle_layer', nowMs) <= 0
      && this.getResolvedLayerWeight('speech_layer', nowMs) <= 0
      && this.getResolvedLayerWeight('backend_pose_layer', nowMs) <= 0;

    if (isMouseOnlyMode) {
      ORIENTATION_CHANNELS.forEach((channel) => {
        const value = finalPose[channel];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          // Mouse-only mode should still pin orientation channels to neutral 0
          // when pointer data is temporarily unavailable, to avoid inheriting
          // stale orientation from legacy motions/previous frames.
          finalPose[channel] = 0;
        }
      });
    }

    const smoothedPose = this.getSmoothedPose(finalPose, nowMs);
    const poseChannels = Object.keys(smoothedPose) as LogicalChannel[];
    if (poseChannels.length === 0) {
      return false;
    }

    let appliedAny = false;

    poseChannels.forEach((channel) => {
      const rawValue = smoothedPose[channel];
      if (typeof rawValue !== 'number') {
        return;
      }

      const sanitizedValue = sanitizeChannelValue(channel, rawValue);
      if (sanitizedValue === null) {
        return;
      }

      const targets = this.profile[channel];
      if (!targets || targets.length === 0) {
        return;
      }

      targets.forEach((target) => {
        if (!target?.id || typeof target.scale !== 'number' || !Number.isFinite(target.scale)) {
          return;
        }

        const parameterId = idManager.getId(target.id);
        const applyMode = target.applyMode ?? 'set';
        this.applyParameterByMode(model, parameterId, sanitizedValue * target.scale, applyMode);
        appliedAny = true;
      });
    });

    return appliedAny;
  }
}

const live2DPoseMixerController = new Live2DPoseMixerController();

export function getLive2DPoseMixerController(): Live2DPoseMixerController {
  return live2DPoseMixerController;
}
