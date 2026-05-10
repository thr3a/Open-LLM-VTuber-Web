import {
  LOGICAL_CHANNELS,
  LogicalChannel,
  PoseFrame,
  PoseValues,
} from '@/live2d/mixer/logical-channels';

export interface PoseLayer {
  id: string;
  weight: number;
  frame: PoseFrame | null;

  // Reserved for future extensions (mask / priority / blend mode).
  enabled?: boolean;
  priority?: number;
  blendMode?: 'weighted';
  mask?: Partial<Record<LogicalChannel, number>>;
}

export interface MixerApplyOptions {
  preferredChannels?: Partial<Record<LogicalChannel, string[]>>;
}

export class Mixer {
  private readonly preferredChannels: Partial<Record<LogicalChannel, string[]>>;

  constructor(options: MixerApplyOptions = {}) {
    this.preferredChannels = options.preferredChannels ?? {};
  }

  private getEffectiveChannelValue(
    activeLayers: PoseLayer[],
    layerId: string,
    channel: LogicalChannel,
  ): number | null {
    const layer = activeLayers.find((candidate) => candidate.id === layerId);
    if (!layer) {
      return null;
    }

    const value = layer.frame?.values?.[channel];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const channelMask = layer.mask?.[channel];
    const channelWeightMultiplier = typeof channelMask === 'number' && Number.isFinite(channelMask)
      ? channelMask
      : 1;
    const effectiveWeight = layer.weight * channelWeightMultiplier;
    if (effectiveWeight <= 0) {
      return null;
    }

    return value;
  }

  private getEffectiveChannelWeight(
    activeLayers: PoseLayer[],
    layerId: string,
    channel: LogicalChannel,
  ): number {
    const layer = activeLayers.find((candidate) => candidate.id === layerId);
    if (!layer) {
      return 0;
    }

    const value = layer.frame?.values?.[channel];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    const channelMask = layer.mask?.[channel];
    const channelWeightMultiplier = typeof channelMask === 'number' && Number.isFinite(channelMask)
      ? channelMask
      : 1;
    const effectiveWeight = layer.weight * channelWeightMultiplier;
    if (!Number.isFinite(effectiveWeight) || effectiveWeight <= 0) {
      return 0;
    }

    return effectiveWeight;
  }

  /**
   * Blend multiple layers into a final (partial) pose.
   * - Missing channels are allowed
   * - Default path: weighted average blend
   * - Preferred channels can short-circuit to specific layers after weighting
   */
  public apply(layers: PoseLayer[]): PoseValues {
    const activeLayers = layers.filter((layer) => {
      if (layer.enabled === false) {
        return false;
      }
      if (!layer.frame) {
        return false;
      }
      return Number.isFinite(layer.weight) && layer.weight > 0;
    });

    const finalPose: PoseValues = {};

    LOGICAL_CHANNELS.forEach((channel) => {
      let weightedSum = 0;
      let weightSum = 0;

      activeLayers.forEach((layer) => {
        const value = layer.frame?.values?.[channel];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return;
        }

        const channelMask = layer.mask?.[channel];
        const channelWeightMultiplier = typeof channelMask === 'number' && Number.isFinite(channelMask)
          ? channelMask
          : 1;

        const effectiveWeight = layer.weight * channelWeightMultiplier;
        if (effectiveWeight <= 0) {
          return;
        }

        weightedSum += value * effectiveWeight;
        weightSum += effectiveWeight;
      });

      if (weightSum > 0) {
        finalPose[channel] = weightedSum / weightSum;
      }

      const preferredLayerIds = this.preferredChannels[channel];
      if (!preferredLayerIds || preferredLayerIds.length === 0) {
        return;
      }

      let preferredWeightedSum = 0;
      let preferredWeightSum = 0;

      for (let index = 0; index < preferredLayerIds.length; index += 1) {
        const preferredLayerId = preferredLayerIds[index];
        const preferredValue = this.getEffectiveChannelValue(activeLayers, preferredLayerId, channel);
        if (preferredValue === null) {
          continue;
        }

        const preferredWeight = this.getEffectiveChannelWeight(
          activeLayers,
          preferredLayerId,
          channel,
        );
        if (preferredWeight <= 0) {
          continue;
        }

        preferredWeightedSum += preferredValue * preferredWeight;
        preferredWeightSum += preferredWeight;
      }

      if (preferredWeightSum > 0) {
        finalPose[channel] = preferredWeightedSum / preferredWeightSum;
      }
    });

    return finalPose;
  }
}
