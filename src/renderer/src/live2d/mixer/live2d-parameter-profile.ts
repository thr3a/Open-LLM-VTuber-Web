import { LogicalChannel } from '@/live2d/mixer/logical-channels';

export type Live2DParameterApplyMode = 'set' | 'add';

export interface Live2DParameterTarget {
  id: string;
  scale: number;

  /**
   * Reserved for future layered ownership (mouse attention/event/etc.).
   * P1/P1.5 default remains `set` to preserve existing behavior.
   */
  applyMode?: Live2DParameterApplyMode;
}

/**
 * Mapping profile from logical channels -> Live2D parameter IDs.
 *
 * First version:
 * - 1 logical channel can map to 0..N Live2D params (most are 1:1).
 * - Missing channels are allowed (e.g. `brow_raise` is model-dependent).
 */
export type Live2DParameterProfile = Partial<Record<LogicalChannel, Live2DParameterTarget[]>>;

export function getDefaultLive2DParameterProfile(): Live2DParameterProfile {
  return {
    head_yaw: [
      { id: 'ParamAngleX', scale: 30, applyMode: 'set' },
      { id: 'ParamAngleX2', scale: 30, applyMode: 'set' },
      { id: 'ParamAngleX3', scale: 30, applyMode: 'set' },
    ],
    head_pitch: [
      { id: 'ParamAngleY', scale: 30, applyMode: 'set' },
      { id: 'ParamAngleY2', scale: 30, applyMode: 'set' },
      { id: 'ParamAngleY3', scale: 30, applyMode: 'set' },
    ],
    head_roll: [
      { id: 'ParamAngleZ', scale: 30, applyMode: 'set' },
      { id: 'ParamAngleZ2', scale: 30, applyMode: 'set' },
    ],
    body_yaw: [
      { id: 'ParamBodyAngleX', scale: 10, applyMode: 'set' },
      { id: 'bodyX', scale: 30, applyMode: 'set' },
    ],
    body_pitch: [
      { id: 'ParamBodyAngleY', scale: 10, applyMode: 'set' },
      { id: 'bodyY', scale: 30, applyMode: 'set' },
    ],
    body_roll: [
      { id: 'ParamBodyAngleZ', scale: 10, applyMode: 'set' },
      { id: 'bodyZ', scale: 30, applyMode: 'set' },
    ],
    gaze_x: [{ id: 'ParamEyeBallX', scale: 1, applyMode: 'set' }],
    gaze_y: [{ id: 'ParamEyeBallY', scale: 1, applyMode: 'set' }],
    eye_l_open: [{ id: 'ParamEyeLOpen', scale: 1, applyMode: 'set' }],
    eye_r_open: [{ id: 'ParamEyeROpen', scale: 1, applyMode: 'set' }],

    // brow_raise: model dependent (reserved for future profiles)

    mouth_open: [{ id: 'ParamMouthOpenY', scale: 1, applyMode: 'set' }],
    mouth_form: [{ id: 'ParamMouthForm', scale: 1, applyMode: 'set' }],
  };
}
