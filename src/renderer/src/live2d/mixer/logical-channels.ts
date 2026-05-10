/**
 * Logical channels decouple business logic from raw Live2D parameter IDs.
 *
 * Convention (first version):
 * - Most channels are normalized to [-1, 1]
 * - `mouth_open` is normalized to [0, 1]
 * - `mouth_form` is normalized to [-1, 1]
 *
 * NOTE: In the long run, head/eye/body orientation should be driven by the mixer
 * rather than static expressions. Expressions should stay focused on facial shapes.
 */

export const LOGICAL_CHANNELS = [
  'head_yaw',
  'head_pitch',
  'head_roll',
  'body_yaw',
  'body_pitch',
  'body_roll',
  'gaze_x',
  'gaze_y',
  'eye_l_open',
  'eye_r_open',
  'brow_raise',
  'mouth_open',
  'mouth_form',
] as const;

export type LogicalChannel = (typeof LOGICAL_CHANNELS)[number];

export type PoseValues = Partial<Record<LogicalChannel, number>>;

export interface PoseFrame {
  values: PoseValues;
}
