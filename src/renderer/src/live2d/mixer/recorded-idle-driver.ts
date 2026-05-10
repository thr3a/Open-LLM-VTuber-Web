import { LogicalChannel, PoseValues } from '@/live2d/mixer/logical-channels';

export type IdlePlaybackMode = 'random' | 'random_no_repeat';

export interface IdleBankClip {
  id?: string;
  url: string;
  weight?: number;
}

export interface IdleBankConfig {
  clips: IdleBankClip[];
  mode?: IdlePlaybackMode;
}

export interface IdlePlayCommand {
  id?: string;
  url?: string;
}

type MotionSegmentType = 0 | 1 | 2 | 3;

interface Motion3Meta {
  Duration?: number;
  Loop?: boolean;
}

interface Motion3Curve {
  Target?: string;
  Id?: string;
  Segments?: number[];
}

interface Motion3File {
  Meta?: Motion3Meta;
  Curves?: Motion3Curve[];
}

interface MotionKeyframe {
  timeSeconds: number;
  value: number;
}

interface ParsedIdleClip {
  sourceUrl: string;
  durationSeconds: number;
  loop: boolean;
  channelCurves: Partial<Record<LogicalChannel, MotionKeyframe[]>>;
}

interface TransitionPlaybackSource {
  clip: ParsedIdleClip | null;
  clipStartTimeSeconds: number | null;
  fallbackPose: PoseValues;
}

interface MotionParameterToChannel {
  channel: LogicalChannel;
  normalizeScale: number;
  priority?: number;
}

const MOTION_PARAMETER_CHANNEL_MAP: Record<string, MotionParameterToChannel> = {
  ParamAngleX: { channel: 'head_yaw', normalizeScale: 30 },
  ParamAngleX2: { channel: 'head_yaw', normalizeScale: 30 },
  ParamAngleX3: { channel: 'head_yaw', normalizeScale: 30 },
  ParamAngleY: { channel: 'head_pitch', normalizeScale: 30 },
  ParamAngleY2: { channel: 'head_pitch', normalizeScale: 30 },
  ParamAngleY3: { channel: 'head_pitch', normalizeScale: 30 },
  ParamAngleZ: { channel: 'head_roll', normalizeScale: 30 },
  ParamAngleZ2: { channel: 'head_roll', normalizeScale: 30 },
  ParamBodyAngleX: { channel: 'body_yaw', normalizeScale: 10, priority: 0 },
  ParamBodyAngleY: { channel: 'body_pitch', normalizeScale: 10, priority: 0 },
  ParamBodyAngleZ: { channel: 'body_roll', normalizeScale: 10, priority: 0 },
  bodyX: { channel: 'body_yaw', normalizeScale: 30, priority: 1 },
  bodyX2: { channel: 'body_yaw', normalizeScale: 30, priority: 2 },
  bodyX3: { channel: 'body_yaw', normalizeScale: 30, priority: 2 },
  bodyY: { channel: 'body_pitch', normalizeScale: 30, priority: 1 },
  bodyZ: { channel: 'body_roll', normalizeScale: 30, priority: 1 },
  bodyZ2: { channel: 'body_roll', normalizeScale: 30, priority: 2 },
  bodyZZ: { channel: 'body_roll', normalizeScale: 30, priority: 2 },
  bodyZZ2: { channel: 'body_roll', normalizeScale: 30, priority: 2 },
  ParamEyeBallX: { channel: 'gaze_x', normalizeScale: 1 },
  ParamEyeBallY: { channel: 'gaze_y', normalizeScale: 1 },
  // 若录制 idle 提供眼皮曲线，则优先由录制数据驱动，
  // 避免 SDK 自动眨眼在 idle 播放期间“抢控制权”。
  ParamEyeLOpen: { channel: 'eye_l_open', normalizeScale: 1 },
  ParamEyeROpen: { channel: 'eye_r_open', normalizeScale: 1 },
  ParamMouthOpenY: { channel: 'mouth_open', normalizeScale: 1 },
  ParamMouthForm: { channel: 'mouth_form', normalizeScale: 1 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// 当前故意关闭 loop seam 混合：
// 边界统一走一条输出过渡链路，避免“双重混合”带来的跳变。
const LOOP_SEAM_BLEND_SECONDS = 0.0;

// 核心衔接时长，覆盖两种场景：
// - 同 clip 循环边界（尾帧 -> 新一轮开头）
// - random 切 clip（上一段 -> 下一段）
// 该过渡发生在输出层，不计入 clip 播放时长。
const CLIP_TRANSITION_BLEND_SECONDS = 2.0;

// 输出姿态的最终低通平滑，用于吸收采样抖动。
const OUTPUT_POSE_SMOOTH_SECONDS = 0.44;

function blendChannelValue(fromValue: number | undefined, toValue: number | undefined, alpha: number): number | null {
  const hasFrom = typeof fromValue === 'number' && Number.isFinite(fromValue);
  const hasTo = typeof toValue === 'number' && Number.isFinite(toValue);
  if (!hasFrom && !hasTo) {
    return null;
  }

  if (!hasFrom) {
    return toValue as number;
  }
  if (!hasTo) {
    return fromValue;
  }

  return fromValue + ((toValue as number) - fromValue) * alpha;
}

function blendPose(fromPose: PoseValues, toPose: PoseValues, alpha: number): PoseValues {
  const boundedAlpha = clamp(alpha, 0, 1);
  const pose: PoseValues = {};
  const channels = new Set<LogicalChannel>([
    ...(Object.keys(fromPose) as LogicalChannel[]),
    ...(Object.keys(toPose) as LogicalChannel[]),
  ]);

  channels.forEach((channel) => {
    const blended = blendChannelValue(fromPose[channel], toPose[channel], boundedAlpha);
    if (blended === null) {
      return;
    }
    pose[channel] = blended;
  });

  return pose;
}

function normalizeMotionSegmentType(value: number): MotionSegmentType | null {
  if (value === 0 || value === 1 || value === 2 || value === 3) {
    return value;
  }
  return null;
}

function parseCurveKeyframes(segments: number[] | undefined): MotionKeyframe[] {
  if (!segments || segments.length < 2) {
    return [];
  }

  const keyframes: MotionKeyframe[] = [];
  const startTime = segments[0];
  const startValue = segments[1];
  if (Number.isFinite(startTime) && Number.isFinite(startValue)) {
    keyframes.push({
      timeSeconds: startTime,
      value: startValue,
    });
  }

  let cursor = 2;
  while (cursor < segments.length) {
    const segmentType = normalizeMotionSegmentType(segments[cursor]);
    if (segmentType === null) {
      break;
    }
    cursor += 1;

    let endTime = Number.NaN;
    let endValue = Number.NaN;

    switch (segmentType) {
      case 0: {
        // Linear: [type, time, value]
        if (cursor + 1 >= segments.length) {
          return keyframes;
        }
        endTime = segments[cursor];
        endValue = segments[cursor + 1];
        cursor += 2;
        break;
      }
      case 1: {
        // Bezier (restricted or unrestricted): [type, c1t, c1v, c2t, c2v, endT, endV]
        if (cursor + 5 >= segments.length) {
          return keyframes;
        }
        endTime = segments[cursor + 4];
        endValue = segments[cursor + 5];
        cursor += 6;
        break;
      }
      case 2:
      case 3: {
        // Stepped / inverse stepped: [type, time, value]
        if (cursor + 1 >= segments.length) {
          return keyframes;
        }
        endTime = segments[cursor];
        endValue = segments[cursor + 1];
        cursor += 2;
        break;
      }
      default:
        return keyframes;
    }

    if (!Number.isFinite(endTime) || !Number.isFinite(endValue)) {
      continue;
    }

    if (keyframes.length > 0 && endTime < keyframes[keyframes.length - 1].timeSeconds) {
      continue;
    }

    keyframes.push({
      timeSeconds: endTime,
      value: endValue,
    });
  }

  return keyframes;
}

function sampleCurveValueAtTime(curve: MotionKeyframe[], timeSeconds: number): number {
  if (curve.length === 0) {
    return 0;
  }

  if (timeSeconds <= curve[0].timeSeconds) {
    return curve[0].value;
  }

  const last = curve[curve.length - 1];
  if (timeSeconds >= last.timeSeconds) {
    return last.value;
  }

  let left = 0;
  let right = curve.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midTime = curve[mid].timeSeconds;
    if (midTime === timeSeconds) {
      return curve[mid].value;
    }
    if (midTime < timeSeconds) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const nextIndex = clamp(left, 1, curve.length - 1);
  const prevIndex = nextIndex - 1;
  const prev = curve[prevIndex];
  const next = curve[nextIndex];
  const duration = next.timeSeconds - prev.timeSeconds;
  if (duration <= 0) {
    return next.value;
  }

  const t = (timeSeconds - prev.timeSeconds) / duration;
  return prev.value + (next.value - prev.value) * t;
}

function getCurveRange(curve: MotionKeyframe[]): number {
  if (curve.length === 0) {
    return 0;
  }

  let minValue = curve[0].value;
  let maxValue = curve[0].value;
  for (let index = 1; index < curve.length; index += 1) {
    const value = curve[index].value;
    if (value < minValue) {
      minValue = value;
    }
    if (value > maxValue) {
      maxValue = value;
    }
  }
  return maxValue - minValue;
}

function parseMotion3Clip(sourceUrl: string, data: Motion3File): ParsedIdleClip | null {
  const durationSeconds = Number.isFinite(data.Meta?.Duration) ? Number(data.Meta?.Duration) : 0;
  if (durationSeconds <= 0) {
    return null;
  }

  const channelCurves: Partial<Record<LogicalChannel, MotionKeyframe[]>> = {};
  const channelCurveMeta: Partial<Record<LogicalChannel, { priority: number; range: number; keyCount: number }>> = {};

  (data.Curves ?? []).forEach((curve) => {
    if (curve.Target !== 'Parameter' || typeof curve.Id !== 'string') {
      return;
    }

    const mapping = MOTION_PARAMETER_CHANNEL_MAP[curve.Id];
    if (!mapping) {
      return;
    }

    const keyframes = parseCurveKeyframes(curve.Segments);
    if (keyframes.length === 0) {
      return;
    }

    const normalized = keyframes.map((point) => ({
      timeSeconds: point.timeSeconds,
      value: point.value / mapping.normalizeScale,
    }));

    const nextPriority = mapping.priority ?? 0;
    const nextRange = getCurveRange(normalized);
    const nextKeyCount = normalized.length;
    const existing = channelCurves[mapping.channel];
    const existingMeta = channelCurveMeta[mapping.channel];
    if (!existing) {
      channelCurves[mapping.channel] = normalized;
      channelCurveMeta[mapping.channel] = {
        priority: nextPriority,
        range: nextRange,
        keyCount: nextKeyCount,
      };
      return;
    }

    const shouldReplace = !existingMeta
      || nextPriority < existingMeta.priority
      || (nextPriority === existingMeta.priority
        && (nextRange > existingMeta.range
          || (Math.abs(nextRange - existingMeta.range) <= 1e-6 && nextKeyCount > existingMeta.keyCount)));
    if (shouldReplace) {
      channelCurves[mapping.channel] = normalized;
      channelCurveMeta[mapping.channel] = {
        priority: nextPriority,
        range: nextRange,
        keyCount: nextKeyCount,
      };
    }
  });

  if (Object.keys(channelCurves).length === 0) {
    return null;
  }

  return {
    sourceUrl,
    durationSeconds,
    loop: data.Meta?.Loop === true,
    channelCurves,
  };
}

function toAbsoluteUrl(pathOrUrl: string, modelUrl?: string): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) {
    return '';
  }

  if (/^(https?:)?\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return trimmed;
  }

  try {
    if (modelUrl) {
      return new URL(trimmed, modelUrl).toString();
    }
    return new URL(trimmed, window.location.href).toString();
  } catch {
    return trimmed;
  }
}

function sanitizeClip(clip: IdleBankClip): IdleBankClip | null {
  const normalizedUrl = typeof clip.url === 'string' ? clip.url.trim() : '';
  if (!normalizedUrl) {
    return null;
  }

  const normalizedWeight = typeof clip.weight === 'number' && Number.isFinite(clip.weight)
    ? Math.max(0, clip.weight)
    : undefined;

  return {
    id: typeof clip.id === 'string' && clip.id.trim() ? clip.id.trim() : undefined,
    url: normalizedUrl,
    weight: normalizedWeight,
  };
}

export function normalizeIdleBankConfig(input: IdleBankConfig | null | undefined): IdleBankConfig | null {
  if (!input || !Array.isArray(input.clips)) {
    return null;
  }

  const clips = input.clips
    .map((clip) => sanitizeClip(clip))
    .filter((clip): clip is IdleBankClip => clip !== null);

  if (clips.length === 0) {
    return null;
  }

  const mode = input.mode === 'random' || input.mode === 'random_no_repeat'
    ? input.mode
    : 'random_no_repeat';

  return {
    clips,
    mode,
  };
}

function getIdleBankPlaybackKey(bank: IdleBankConfig | null, modelUrl?: string): string {
  if (!bank || bank.clips.length === 0) {
    return '';
  }

  return bank.clips
    .map((clip) => toAbsoluteUrl(clip.url, modelUrl))
    .sort()
    .join('|');
}

function areIdleBanksPlaybackCompatible(
  left: IdleBankConfig | null,
  right: IdleBankConfig | null,
  modelUrl?: string,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return getIdleBankPlaybackKey(left, modelUrl) === getIdleBankPlaybackKey(right, modelUrl);
}

function normalizeIdlePlayCommand(input: IdlePlayCommand | string | null | undefined): IdlePlayCommand | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('.')) {
      return { url: trimmed };
    }
    return { id: trimmed };
  }

  if (!input || typeof input !== 'object') {
    return null;
  }

  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
  if (!id && !url) {
    return null;
  }
  return { id, url };
}

type IdleClipSource = 'bank' | 'manual';

export class RecordedIdleDriver {
  private readonly clipCache = new Map<string, Promise<ParsedIdleClip | null>>();

  private modelUrl?: string;

  private bank: IdleBankConfig | null = null;

  private isLoading = false;

  private activeClip: ParsedIdleClip | null = null;

  private activeClipIndex = -1;

  private activeClipSource: IdleClipSource = 'bank';

  private previousClipIndex = -1;

  private activeClipStartTimeSeconds = 0;

  private queuedTransitionSource: TransitionPlaybackSource | null = null;

  private transitionSource: TransitionPlaybackSource | null = null;

  private transitionStartTimeSeconds: number | null = null;

  private requestToken = 0;

  private latestPose: PoseValues = {};

  private smoothedPose: PoseValues = {};

  private lastOutputTimeSeconds: number | null = null;

  constructor(private readonly onPose: (pose: PoseValues) => void) {}

  public setModelUrl(modelUrl?: string): void {
    if (this.modelUrl === modelUrl) {
      return;
    }

    this.modelUrl = modelUrl;
    this.resetPlaybackState();
  }

  public setIdleBank(bank: IdleBankConfig | null): void {
    const normalized = normalizeIdleBankConfig(bank);
    const shouldPreservePlayback = this.activeClip !== null
      && areIdleBanksPlaybackCompatible(this.bank, normalized, this.modelUrl);
    this.bank = normalized;

    if (shouldPreservePlayback) {
      return;
    }

    const transitionSource = this.captureCurrentTransitionSource();
    this.resetPlaybackState(transitionSource);

    if (!this.bank) {
      this.pushPose({});
    }
  }

  public clearIdleBank(): void {
    const transitionSource = this.captureCurrentTransitionSource();
    this.bank = null;
    this.resetPlaybackState(transitionSource);
    this.pushPose({});
  }

  public playManualClip(command: IdlePlayCommand | string | null | undefined, nowSeconds: number): void {
    const normalized = normalizeIdlePlayCommand(command);
    if (!normalized || !Number.isFinite(nowSeconds)) {
      return;
    }

    const fromBank = normalized.id
      ? this.bank?.clips.findIndex((clip) => clip.id === normalized.id) ?? -1
      : -1;

    if (fromBank >= 0 && this.bank) {
      void this.selectClip(nowSeconds, this.bank.clips[fromBank], fromBank, 'manual');
      return;
    }

    if (!normalized.url) {
      return;
    }

    const sanitized = sanitizeClip({
      id: normalized.id,
      url: normalized.url,
    });
    if (!sanitized) {
      return;
    }

    void this.selectClip(nowSeconds, sanitized, -1, 'manual');
  }

  public update(nowSeconds: number): void {
    if (!this.activeClip && (!this.bank || this.bank.clips.length === 0)) {
      return;
    }

    if (!Number.isFinite(nowSeconds)) {
      return;
    }

    if (!this.activeClip) {
      if (!this.isLoading && this.bank && this.bank.clips.length > 0) {
        void this.selectNextClip(nowSeconds);
      }
      return;
    }

    const duration = Math.max(0.001, this.activeClip.durationSeconds);
    let elapsed = nowSeconds - this.activeClipStartTimeSeconds;
    if (elapsed >= duration) {
      if (this.activeClipSource === 'manual') {
        this.activeClip = null;
        this.activeClipIndex = -1;
        this.activeClipSource = 'bank';
        if (this.bank && this.bank.clips.length > 0) {
          void this.selectNextClip(nowSeconds);
        } else {
          this.pushPose({});
        }
        return;
      }

      if (this.bank && this.bank.clips.length === 1 && this.activeClip.loop) {
        // 保持播放时间连续（elapsed 回卷），并在输出层做短过渡，
        // 这样边界平滑不会“吃掉”动画时间。
        // 关键点：以最近一次已输出的姿态作为过渡起点，
        // 保证从用户当前看到的画面自然接续。
        const tailPose = Object.keys(this.latestPose).length > 0
          ? { ...this.latestPose }
          : this.samplePose(this.activeClip, duration);
        elapsed %= duration;
        this.activeClipStartTimeSeconds = nowSeconds - elapsed;
        this.transitionSource = {
          clip: null,
          clipStartTimeSeconds: null,
          fallbackPose: tailPose,
        };
        this.transitionStartTimeSeconds = nowSeconds;
      } else {
        void this.selectNextClip(nowSeconds);
        return;
      }
    }

    const boundedElapsed = Math.min(Math.max(0, elapsed), duration);
    let pose = this.samplePoseWithLoopSeamBlend(this.activeClip, boundedElapsed);

    if (this.transitionSource && this.transitionStartTimeSeconds !== null) {
      const transitionElapsed = nowSeconds - this.transitionStartTimeSeconds;
      const transitionAlpha = clamp(transitionElapsed / CLIP_TRANSITION_BLEND_SECONDS, 0, 1);
      pose = blendPose(this.sampleTransitionSource(this.transitionSource, nowSeconds), pose, transitionAlpha);

      if (transitionAlpha >= 1) {
        this.transitionSource = null;
        this.transitionStartTimeSeconds = null;
      }
    }

    const smoothedPose = this.smoothOutputPose(pose, nowSeconds);
    this.pushPose(smoothedPose);
  }

  public getDebugState() {
    const clip = this.activeClipIndex >= 0 ? this.bank?.clips[this.activeClipIndex] : undefined;
    return {
      hasBank: Boolean(this.bank),
      mode: this.bank?.mode ?? null,
      clipCount: this.bank?.clips.length ?? 0,
      isLoading: this.isLoading,
      modelUrl: this.modelUrl ?? null,
      activeClipSource: this.activeClipSource,
      activeClipIndex: this.activeClipIndex,
      activeClipId: clip?.id ?? null,
      activeClipUrl: clip?.url ?? null,
      activeClipResolvedUrl: this.activeClip?.sourceUrl ?? null,
      activeClipDurationSeconds: this.activeClip?.durationSeconds ?? null,
      latestPose: { ...this.latestPose },
    };
  }

  private resetPlaybackState(queuedTransitionSource: TransitionPlaybackSource | null = null): void {
    this.requestToken += 1;
    this.isLoading = false;
    this.activeClip = null;
    this.activeClipIndex = -1;
    this.activeClipSource = 'bank';
    this.previousClipIndex = -1;
    this.activeClipStartTimeSeconds = 0;
    this.queuedTransitionSource = queuedTransitionSource;
    this.transitionSource = null;
    this.transitionStartTimeSeconds = null;
    this.smoothedPose = {};
    this.lastOutputTimeSeconds = null;
  }

  private captureCurrentTransitionSource(): TransitionPlaybackSource | null {
    if (this.activeClip) {
      return {
        clip: this.activeClip,
        clipStartTimeSeconds: this.activeClipStartTimeSeconds,
        fallbackPose: { ...this.latestPose },
      };
    }

    if (Object.keys(this.latestPose).length > 0) {
      return {
        clip: null,
        clipStartTimeSeconds: null,
        fallbackPose: { ...this.latestPose },
      };
    }

    return null;
  }

  private sampleClipForTransition(clip: ParsedIdleClip, elapsedSeconds: number): PoseValues {
    const duration = Math.max(0.001, clip.durationSeconds);
    if (clip.loop) {
      return this.samplePoseWithLoopSeamBlend(clip, elapsedSeconds % duration);
    }

    return this.samplePose(clip, Math.min(Math.max(0, elapsedSeconds), duration));
  }

  private sampleTransitionSource(source: TransitionPlaybackSource, nowSeconds: number): PoseValues {
    if (source.clip && source.clipStartTimeSeconds !== null) {
      return this.sampleClipForTransition(
        source.clip,
        Math.max(0, nowSeconds - source.clipStartTimeSeconds),
      );
    }

    return { ...source.fallbackPose };
  }

  private pushPose(pose: PoseValues): void {
    this.latestPose = { ...pose };
    this.onPose(this.latestPose);
  }

  private smoothOutputPose(targetPose: PoseValues, nowSeconds: number): PoseValues {
    if (!Number.isFinite(nowSeconds)) {
      return targetPose;
    }

    if (OUTPUT_POSE_SMOOTH_SECONDS <= 0) {
      this.smoothedPose = { ...targetPose };
      this.lastOutputTimeSeconds = nowSeconds;
      return targetPose;
    }

    const targetChannels = Object.keys(targetPose) as LogicalChannel[];
    if (targetChannels.length === 0) {
      this.smoothedPose = {};
      this.lastOutputTimeSeconds = nowSeconds;
      return {};
    }

    const previousTimeSeconds = this.lastOutputTimeSeconds;
    if (previousTimeSeconds === null) {
      this.smoothedPose = { ...targetPose };
      this.lastOutputTimeSeconds = nowSeconds;
      return { ...targetPose };
    }

    // 指数平滑 + dt 补偿，降低不同帧率下的可见卡顿感。
    const dtSeconds = clamp(nowSeconds - previousTimeSeconds, 1 / 240, 0.2);
    const alpha = 1 - Math.exp(-dtSeconds / OUTPUT_POSE_SMOOTH_SECONDS);
    const nextPose: PoseValues = {};

    targetChannels.forEach((channel) => {
      const targetValue = targetPose[channel];
      if (typeof targetValue !== 'number' || !Number.isFinite(targetValue)) {
        return;
      }

      const previousValue = this.smoothedPose[channel];
      const fromValue = typeof previousValue === 'number' && Number.isFinite(previousValue)
        ? previousValue
        : targetValue;

      nextPose[channel] = fromValue + (targetValue - fromValue) * alpha;
    });

    this.smoothedPose = nextPose;
    this.lastOutputTimeSeconds = nowSeconds;
    return nextPose;
  }

  private samplePose(clip: ParsedIdleClip, elapsedSeconds: number): PoseValues {
    const pose: PoseValues = {};

    (Object.keys(clip.channelCurves) as LogicalChannel[]).forEach((channel) => {
      const curve = clip.channelCurves[channel];
      if (!curve || curve.length === 0) {
        return;
      }

      pose[channel] = sampleCurveValueAtTime(curve, elapsedSeconds);
    });

    return pose;
  }

  private samplePoseWithLoopSeamBlend(clip: ParsedIdleClip, elapsedSeconds: number): PoseValues {
    const duration = Math.max(0.001, clip.durationSeconds);
    if (!clip.loop) {
      return this.samplePose(clip, elapsedSeconds);
    }

    const wrappedElapsed = elapsedSeconds % duration;
    const poseAtTime = this.samplePose(clip, wrappedElapsed);
    const seamWindow = Math.min(LOOP_SEAM_BLEND_SECONDS, duration * 0.25);
    if (seamWindow <= 0 || wrappedElapsed < duration - seamWindow) {
      return poseAtTime;
    }

    const nearLoopAlpha = (wrappedElapsed - (duration - seamWindow)) / seamWindow;
    const loopStartPose = this.samplePose(clip, 0);
    return blendPose(poseAtTime, loopStartPose, nearLoopAlpha);
  }

  private pickWeightedRandomIndex(candidateIndexes: number[]): number {
    if (!this.bank || candidateIndexes.length === 0) {
      return -1;
    }

    const weighted = candidateIndexes.map((index) => {
      const weight = this.bank?.clips[index]?.weight;
      const normalized = typeof weight === 'number' && Number.isFinite(weight) ? Math.max(0, weight) : 1;
      return { index, weight: normalized };
    });

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) {
      const randomIndex = Math.floor(Math.random() * candidateIndexes.length);
      return candidateIndexes[randomIndex];
    }

    let cursor = Math.random() * totalWeight;
    for (let i = 0; i < weighted.length; i += 1) {
      cursor -= weighted[i].weight;
      if (cursor <= 0) {
        return weighted[i].index;
      }
    }

    return weighted[weighted.length - 1].index;
  }

  private pickNextClipIndex(): number {
    if (!this.bank || this.bank.clips.length === 0) {
      return -1;
    }

    const clipCount = this.bank.clips.length;
    const allIndexes = Array.from({ length: clipCount }, (_, index) => index);
    const mode = this.bank.mode ?? 'random_no_repeat';

    if (mode === 'random_no_repeat' && clipCount > 1 && this.previousClipIndex >= 0) {
      const withoutPrevious = allIndexes.filter((index) => index !== this.previousClipIndex);
      return this.pickWeightedRandomIndex(withoutPrevious);
    }

    return this.pickWeightedRandomIndex(allIndexes);
  }

  private async selectNextClip(nowSeconds: number): Promise<void> {
    if (!this.bank || this.bank.clips.length === 0) {
      return;
    }

    const nextIndex = this.pickNextClipIndex();
    if (nextIndex < 0) {
      return;
    }

    await this.selectClip(nowSeconds, this.bank.clips[nextIndex], nextIndex, 'bank');
  }

  private activateClip(
    parsedClip: ParsedIdleClip,
    nowSeconds: number,
    source: IdleClipSource,
    clipIndex: number,
  ): void {
    const previousSource = this.queuedTransitionSource ?? this.captureCurrentTransitionSource();
    this.queuedTransitionSource = null;

    if (source === 'bank' && clipIndex >= 0) {
      this.previousClipIndex = clipIndex;
    }

    this.activeClipSource = source;
    this.activeClipIndex = clipIndex;
    this.activeClip = parsedClip;
    this.activeClipStartTimeSeconds = nowSeconds;
    this.transitionSource = previousSource;
    this.transitionStartTimeSeconds = this.transitionSource ? nowSeconds : null;

    const initialPose = this.samplePoseWithLoopSeamBlend(parsedClip, 0);
    this.pushPose(this.transitionSource ? blendPose(this.sampleTransitionSource(this.transitionSource, nowSeconds), initialPose, 0) : initialPose);
  }

  private async selectClip(
    nowSeconds: number,
    selectedClip: IdleBankClip,
    clipIndex: number,
    source: IdleClipSource,
  ): Promise<void> {
    const resolvedUrl = toAbsoluteUrl(selectedClip.url, this.modelUrl);
    if (!resolvedUrl) {
      return;
    }

    this.isLoading = true;
    const token = ++this.requestToken;

    const parsedClip = await this.loadClip(resolvedUrl);
    if (token !== this.requestToken) {
      return;
    }

    this.isLoading = false;

    if (!parsedClip) {
      return;
    }

    this.activateClip(parsedClip, nowSeconds, source, clipIndex);
  }

  private async loadClip(resolvedUrl: string): Promise<ParsedIdleClip | null> {
    const cached = this.clipCache.get(resolvedUrl);
    if (cached) {
      return cached;
    }

    const loader = (async () => {
      try {
        const response = await fetch(resolvedUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch idle clip: ${response.status}`);
        }

        const motion3 = await response.json() as Motion3File;
        const parsed = parseMotion3Clip(resolvedUrl, motion3);
        return parsed;
      } catch (error) {
        console.warn('[RecordedIdleDriver] failed to load idle clip:', resolvedUrl, error);
        return null;
      }
    })();

    this.clipCache.set(resolvedUrl, loader);
    return loader;
  }
}
