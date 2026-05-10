/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-use-before-define */
/* eslint-disable no-param-reassign */
/* eslint-disable @typescript-eslint/no-unused-vars */
// @ts-nocheck
import { useEffect, useRef, useCallback, useState, RefObject } from "react";
import { ModelInfo } from "@/context/live2d-config-context";
import { updateModelConfig } from '../../../WebSDK/src/lappdefine';
import { LAppDelegate } from '../../../WebSDK/src/lappdelegate';
import { LAppLive2DManager } from '../../../WebSDK/src/lapplive2dmanager';
import { initializeLive2D } from '@cubismsdksamples/main';
import { useMode } from '@/context/mode-context';
import { getLive2DPoseMixerController } from '@/hooks/canvas/live2d-pose-mixer-controller';

interface UseLive2DModelProps {
  modelInfo: ModelInfo | undefined;
  canvasRef: RefObject<HTMLCanvasElement>;
}

interface Position {
  x: number;
  y: number;
}

interface MouseFollowPose {
  head_yaw: number;
  head_pitch: number;
  head_roll: number;
  body_yaw: number;
  gaze_x: number;
  gaze_y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const MOUSE_FOLLOW_START_DELAY_MS = 2000;
const MOUSE_FOLLOW_SMOOTH_TIME_SECONDS = 0.28;
const MOUSE_FOLLOW_MAX_SPEED_PER_SECOND = 2.3;
const LOCAL_POINTER_PRIORITY_WINDOW_MS = 120;

// Thresholds for tap vs drag detection
const TAP_DURATION_THRESHOLD_MS = 200; // Max duration for a tap
const DRAG_DISTANCE_THRESHOLD_PX = 5; // Min distance to be considered a drag

function parseModelUrl(url: string): { baseUrl: string; modelDir: string; modelFileName: string } {
  try {
    const urlObj = new URL(url);
    const { pathname } = urlObj;

    const lastSlashIndex = pathname.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      throw new Error('Invalid model URL format');
    }

    const fullFileName = pathname.substring(lastSlashIndex + 1);
    const modelFileName = fullFileName.replace('.model3.json', '');

    const secondLastSlashIndex = pathname.lastIndexOf('/', lastSlashIndex - 1);
    if (secondLastSlashIndex === -1) {
      throw new Error('Invalid model URL format');
    }

    const modelDir = pathname.substring(secondLastSlashIndex + 1, lastSlashIndex);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}${pathname.substring(0, secondLastSlashIndex + 1)}`;

    return { baseUrl, modelDir, modelFileName };
  } catch (error) {
    console.error('Error parsing model URL:', error);
    return { baseUrl: '', modelDir: '', modelFileName: '' };
  }
}

export const playAudioWithLipSync = (audioPath: string, modelIndex = 0): Promise<void> => new Promise((resolve, reject) => {
  const live2dManager = window.LAppLive2DManager?.getInstance();
  if (!live2dManager) {
    reject(new Error('Live2D manager not initialized'));
    return;
  }

  const fullPath = `/Resources/${audioPath}`;
  const audio = new Audio(fullPath);

  audio.addEventListener('canplaythrough', () => {
    const model = live2dManager.getModel(modelIndex);
    if (model) {
      if (model._wavFileHandler) {
        model._wavFileHandler.start(fullPath);
        audio.play();
      } else {
        reject(new Error('Wav file handler not available on model'));
      }
    } else {
      reject(new Error(`Model index ${modelIndex} not found`));
    }
  });

  audio.addEventListener('ended', () => {
    resolve();
  });

  audio.addEventListener('error', () => {
    reject(new Error(`Failed to load audio: ${fullPath}`));
  });

  audio.load();
});

export const useLive2DModel = ({
  modelInfo,
  canvasRef,
}: UseLive2DModelProps) => {
  const { mode } = useMode();
  const isPet = mode === 'pet';
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const dragStartPos = useRef<Position>({ x: 0, y: 0 }); // Screen coordinates at drag start
  const modelStartPos = useRef<Position>({ x: 0, y: 0 }); // Model coordinates at drag start
  const modelPositionRef = useRef<Position>({ x: 0, y: 0 });
  const prevModelUrlRef = useRef<string | null>(null);
  const isHoveringModelRef = useRef(false);
  const mouseFollowEnableAtRef = useRef<number>(performance.now() + MOUSE_FOLLOW_START_DELAY_MS);
  const mouseFollowPoseRef = useRef<MouseFollowPose>({
    head_yaw: 0,
    head_pitch: 0,
    head_roll: 0,
    body_yaw: 0,
    gaze_x: 0,
    gaze_y: 0,
  });
  const mouseFollowTargetPoseRef = useRef<MouseFollowPose>({
    head_yaw: 0,
    head_pitch: 0,
    head_roll: 0,
    body_yaw: 0,
    gaze_x: 0,
    gaze_y: 0,
  });
  const mouseFollowActiveRef = useRef<boolean>(false);
  const mouseFollowLastUpdateMsRef = useRef<number | null>(null);
  const localPointerPriorityUntilMsRef = useRef<number>(0);
  const electronApi = (window as any).electron;

  // --- State for Tap vs Drag ---
  const mouseDownTimeRef = useRef<number>(0);
  const mouseDownPosRef = useRef<Position>({ x: 0, y: 0 }); // Screen coords at mousedown
  const isPotentialTapRef = useRef<boolean>(false); // Flag for ongoing potential tap/drag action
  // ---

  const resetMouseFollowSmoothing = useCallback(() => {
    mouseFollowPoseRef.current = {
      head_yaw: 0,
      head_pitch: 0,
      head_roll: 0,
      body_yaw: 0,
      gaze_x: 0,
      gaze_y: 0,
    };
    mouseFollowTargetPoseRef.current = {
      head_yaw: 0,
      head_pitch: 0,
      head_roll: 0,
      body_yaw: 0,
      gaze_x: 0,
      gaze_y: 0,
    };
    mouseFollowActiveRef.current = false;
    mouseFollowLastUpdateMsRef.current = null;
  }, []);

  const clearMouseAttentionFollow = useCallback(() => {
    resetMouseFollowSmoothing();
    getLive2DPoseMixerController().clearMouseAttention();
  }, [resetMouseFollowSmoothing]);

  useEffect(() => {
    const currentUrl = modelInfo?.url;
    const sdkScale = (window as any).LAppDefine?.CurrentKScale;
    const modelScale = modelInfo?.kScale !== undefined ? Number(modelInfo.kScale) : undefined;

    if (!currentUrl) {
      mouseFollowEnableAtRef.current = Number.POSITIVE_INFINITY;
      clearMouseAttentionFollow();
      return;
    }

    const needsUpdate = currentUrl &&
                        (currentUrl !== prevModelUrlRef.current ||
                         (sdkScale !== undefined && modelScale !== undefined && sdkScale !== modelScale));

    if (needsUpdate) {
      prevModelUrlRef.current = currentUrl;
      mouseFollowEnableAtRef.current = performance.now() + MOUSE_FOLLOW_START_DELAY_MS;
      clearMouseAttentionFollow();

      try {
        const { baseUrl, modelDir, modelFileName } = parseModelUrl(currentUrl);

        if (baseUrl && modelDir) {
          updateModelConfig(
            baseUrl,
            modelDir,
            modelFileName,
            Number(modelInfo.kScale),
            modelInfo.idleMotionGroupName,
          );

          setTimeout(() => {
            if ((window as any).LAppLive2DManager?.releaseInstance) {
              (window as any).LAppLive2DManager.releaseInstance();
            }
            initializeLive2D();
          }, 500);
        }
      } catch (error) {
        console.error('Error processing model URL:', error);
      }
    }
  }, [modelInfo?.url, modelInfo?.kScale, modelInfo?.idleMotionGroupName, clearMouseAttentionFollow]);

  const getModelPosition = useCallback(() => {
    const adapter = (window as any).getLAppAdapter?.();
    if (adapter) {
      const model = adapter.getModel();
      if (model && model._modelMatrix) {
        const matrix = model._modelMatrix.getArray();
        return {
          x: matrix[12],
          y: matrix[13],
        };
      }
    }
    return { x: 0, y: 0 };
  }, []);

  const setModelPosition = useCallback((x: number, y: number) => {
    const adapter = (window as any).getLAppAdapter?.();
    if (adapter) {
      const model = adapter.getModel();
      if (model && model._modelMatrix) {
        const matrix = model._modelMatrix.getArray();

        const newMatrix = [...matrix];
        newMatrix[12] = x;
        newMatrix[13] = y;

        model._modelMatrix.setMatrix(newMatrix);
        modelPositionRef.current = { x, y };
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const currentPos = getModelPosition();
      modelPositionRef.current = currentPos;
      setPosition(currentPos);
    }, 500);

    return () => clearTimeout(timer);
  }, [modelInfo?.url, getModelPosition]);

  const getCanvasScale = useCallback(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) return { width: 1, height: 1, scale: 1 };

    const { width } = canvas;
    const { height } = canvas;
    const scale = width / canvas.clientWidth;

    return { width, height, scale };
  }, []);

  const screenToModelPosition = useCallback((screenX: number, screenY: number) => {
    const { width, height, scale } = getCanvasScale();

    const x = ((screenX * scale) / width) * 2 - 1;
    const y = -((screenY * scale) / height) * 2 + 1;

    return { x, y };
  }, [getCanvasScale]);

  const getModelScreenBounds = useCallback((model: any) => {
    const drawableModel = model?._model;
    const matrix = model?._modelMatrix?.getArray?.();
    const drawableCount = drawableModel?.getDrawableCount?.();

    if (!drawableModel || !matrix || !drawableCount) {
      return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < drawableCount; i += 1) {
      if (drawableModel.getDrawableDynamicFlagIsVisible && !drawableModel.getDrawableDynamicFlagIsVisible(i)) {
        continue;
      }

      const vertices = drawableModel.getDrawableVertices(i);
      if (!vertices || vertices.length < 2) {
        continue;
      }

      for (let j = 0; j < vertices.length; j += 2) {
        const vx = vertices[j];
        const vy = vertices[j + 1];
        const screenX = vx * matrix[0] + vy * matrix[4] + matrix[12];
        const screenY = vx * matrix[1] + vy * matrix[5] + matrix[13];

        minX = Math.min(minX, screenX);
        minY = Math.min(minY, screenY);
        maxX = Math.max(maxX, screenX);
        maxY = Math.max(maxY, screenY);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    const width = Math.max(maxX - minX, 0.5);
    const height = Math.max(maxY - minY, 0.5);

    return {
      minX,
      minY,
      maxX,
      maxY,
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
      halfWidth: width * 0.5,
      halfHeight: height * 0.5,
    };
  }, []);

  const getPointerModelCoordinates = useCallback((clientX: number, clientY: number) => {
    const adapter = (window as any).getLAppAdapter?.();
    const view = LAppDelegate.getInstance().getView();
    const model = adapter?.getModel();
    const canvas = canvasRef.current;

    if (!view || !model || !canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const scaleX = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
    const scaleY = canvas.clientHeight ? canvas.height / canvas.clientHeight : 1;
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
    const modelX = view._deviceToScreen.transformX(scaledX);
    const modelY = view._deviceToScreen.transformY(scaledY);
    const viewX = typeof view.transformViewX === 'function'
      ? view.transformViewX(scaledX)
      : modelX;
    const viewY = typeof view.transformViewY === 'function'
      ? view.transformViewY(scaledY)
      : modelY;

    return {
      adapter,
      view,
      model,
      canvas,
      rect,
      x,
      y,
      scaledX,
      scaledY,
      modelX,
      modelY,
      viewX,
      viewY,
      screenBounds: getModelScreenBounds(model),
    };
  }, [canvasRef, getModelScreenBounds]);

  const finalizeDragPosition = useCallback(() => {
    const adapter = (window as any).getLAppAdapter?.();
    if (adapter) {
      const currentModel = adapter.getModel();
      if (currentModel && currentModel._modelMatrix) {
        const matrix = currentModel._modelMatrix.getArray();
        const finalPos = { x: matrix[12], y: matrix[13] };
        modelPositionRef.current = finalPos;
        modelStartPos.current = finalPos;
        setPosition(finalPos);
      }
    }
    setIsDragging(false);
  }, []);

  const updateMouseFollow = useCallback((clientX: number, clientY: number) => {
    if (performance.now() < mouseFollowEnableAtRef.current) {
      clearMouseAttentionFollow();
      return;
    }

    if (isDragging) {
      clearMouseAttentionFollow();
      return;
    }

    const pointer = getPointerModelCoordinates(clientX, clientY);
    if (!pointer?.model?._modelMatrix) {
      clearMouseAttentionFollow();
      return;
    }

    // Drive mouse-attention relative to the model's current on-screen bounds,
    // so pet-mode repositioning does not change the apparent look-at anchor.
    const normalizedX = pointer.screenBounds
      ? clamp((pointer.modelX - pointer.screenBounds.centerX) / pointer.screenBounds.halfWidth, -1, 1)
      : clamp(pointer.viewX, -1, 1);
    const normalizedY = pointer.screenBounds
      ? clamp((pointer.modelY - pointer.screenBounds.centerY) / pointer.screenBounds.halfHeight, -1, 1)
      : clamp(pointer.viewY, -1, 1);
    mouseFollowTargetPoseRef.current = {
      head_yaw: normalizedX,
      head_pitch: normalizedY,
      head_roll: normalizedX * normalizedY * -1,
      body_yaw: normalizedX,
      gaze_x: normalizedX,
      gaze_y: normalizedY,
    };
    mouseFollowActiveRef.current = true;
  }, [getPointerModelCoordinates, isDragging, clearMouseAttentionFollow]);

  useEffect(() => {
    let rafId = 0;
    let isDisposed = false;
    const poseMixerController = getLive2DPoseMixerController();

    const tick = (nowMs: number) => {
      if (isDisposed) {
        return;
      }

      if (
        mouseFollowActiveRef.current
        && !isDragging
        && nowMs >= mouseFollowEnableAtRef.current
      ) {
        const lastUpdateMs = mouseFollowLastUpdateMsRef.current ?? (nowMs - 16.7);
        const dtSeconds = clamp((nowMs - lastUpdateMs) * 0.001, 1 / 240, 0.1);
        mouseFollowLastUpdateMsRef.current = nowMs;

        const alpha = 1 - Math.exp(-dtSeconds / MOUSE_FOLLOW_SMOOTH_TIME_SECONDS);
        const maxStep = MOUSE_FOLLOW_MAX_SPEED_PER_SECOND * dtSeconds;
        const prev = mouseFollowPoseRef.current;
        const target = mouseFollowTargetPoseRef.current;
        const smooth = (from: number, to: number): number => {
          const interpolated = from + (to - from) * alpha;
          const delta = clamp(interpolated - from, -maxStep, maxStep);
          return clamp(from + delta, -1, 1);
        };

        const next: MouseFollowPose = {
          head_yaw: smooth(prev.head_yaw, target.head_yaw),
          head_pitch: smooth(prev.head_pitch, target.head_pitch),
          head_roll: smooth(prev.head_roll, target.head_roll),
          body_yaw: smooth(prev.body_yaw, target.body_yaw),
          gaze_x: smooth(prev.gaze_x, target.gaze_x),
          gaze_y: smooth(prev.gaze_y, target.gaze_y),
        };

        mouseFollowPoseRef.current = next;
        poseMixerController.setMouseAttentionPose(next);
      } else {
        mouseFollowLastUpdateMsRef.current = null;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      isDisposed = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [isDragging]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const adapter = (window as any).getLAppAdapter?.();
    if (!adapter || !canvasRef.current) return;

    const model = adapter.getModel();
    const view = LAppDelegate.getInstance().getView();
    if (!view || !model) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left; // Screen X relative to canvas
    const y = e.clientY - rect.top; // Screen Y relative to canvas

    // --- Check if click is on model ---
    const scale = canvas.width / canvas.clientWidth;
    const scaledX = x * scale;
    const scaledY = y * scale;
    const modelX = view._deviceToScreen.transformX(scaledX);
    const modelY = view._deviceToScreen.transformY(scaledY);

    const hitAreaName = model.anyhitTest(modelX, modelY);
    const isHitOnModel = model.isHitOnModel(modelX, modelY);
    // --- End Check ---

    if (hitAreaName !== null || isHitOnModel) {
      // Record potential tap/drag start
      mouseDownTimeRef.current = Date.now();
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; // Use clientX/Y for distance check
      isPotentialTapRef.current = true;
      setIsDragging(false); // Ensure dragging is false initially

      // Store initial model position IF drag starts later
      if (model._modelMatrix) {
        const matrix = model._modelMatrix.getArray();
        modelStartPos.current = { x: matrix[12], y: matrix[13] };
      }
    }
  }, [canvasRef, modelInfo]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const adapter = (window as any).getLAppAdapter?.();
    const view = LAppDelegate.getInstance().getView();
    const model = adapter?.getModel();

    // --- Start Drag Logic ---
    if (isPotentialTapRef.current && adapter && view && model && canvasRef.current) {
      const timeElapsed = Date.now() - mouseDownTimeRef.current;
      const deltaX = e.clientX - mouseDownPosRef.current.x;
      const deltaY = e.clientY - mouseDownPosRef.current.y;
      const distanceMoved = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Check if it's a drag (moved enough distance OR held long enough while moving slightly)
      if (distanceMoved > DRAG_DISTANCE_THRESHOLD_PX || (timeElapsed > TAP_DURATION_THRESHOLD_MS && distanceMoved > 1)) {
        isPotentialTapRef.current = false; // It's a drag, not a tap
        setIsDragging(true);

        // Set initial drag screen position using the position from mousedown
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        dragStartPos.current = {
          x: mouseDownPosRef.current.x - rect.left,
          y: mouseDownPosRef.current.y - rect.top,
        };
        // modelStartPos is already set in handleMouseDown
      }
    }
    // --- End Start Drag Logic ---

    // --- Continue Drag Logic ---
    if (isDragging && adapter && view && model && canvasRef.current) {
      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const currentX = e.clientX - rect.left; // Current screen X relative to canvas
      const currentY = e.clientY - rect.top; // Current screen Y relative to canvas

      // Convert screen delta to model delta
      const scale = canvas.width / canvas.clientWidth;
      const startScaledX = dragStartPos.current.x * scale;
      const startScaledY = dragStartPos.current.y * scale;
      const startModelX = view._deviceToScreen.transformX(startScaledX);
      const startModelY = view._deviceToScreen.transformY(startScaledY);

      const currentScaledX = currentX * scale;
      const currentScaledY = currentY * scale;
      const currentModelX = view._deviceToScreen.transformX(currentScaledX);
      const currentModelY = view._deviceToScreen.transformY(currentScaledY);

      const dx = currentModelX - startModelX;
      const dy = currentModelY - startModelY;

      const newX = modelStartPos.current.x + dx;
      const newY = modelStartPos.current.y + dy;

      // Use the adapter's setModelPosition method if available, otherwise update matrix directly
      if (adapter.setModelPosition) {
        adapter.setModelPosition(newX, newY);
      } else if (model._modelMatrix) {
        const matrix = model._modelMatrix.getArray();
        const newMatrix = [...matrix];
        newMatrix[12] = newX;
        newMatrix[13] = newY;
        model._modelMatrix.setMatrix(newMatrix);
      }

      modelPositionRef.current = { x: newX, y: newY };
      setPosition({ x: newX, y: newY }); // Update React state if needed for UI feedback
    }
    // --- End Continue Drag Logic ---

    // --- Mouse Follow Logic (gaze + head + body follow mouse) ---
    localPointerPriorityUntilMsRef.current = performance.now() + LOCAL_POINTER_PRIORITY_WINDOW_MS;
    updateMouseFollow(e.clientX, e.clientY);
    // --- End Mouse Follow Logic ---

    // --- Pet Hover Logic (Unchanged) ---
    if (isPet && !isDragging && !isPotentialTapRef.current && electronApi && adapter && view && model && canvasRef.current) {
      const pointer = getPointerModelCoordinates(e.clientX, e.clientY);
      if (!pointer) {
        return;
      }

      const currentHitState = model.anyhitTest(pointer.modelX, pointer.modelY) !== null
        || model.isHitOnModel(pointer.modelX, pointer.modelY);

      if (currentHitState !== isHoveringModelRef.current) {
        isHoveringModelRef.current = currentHitState;
        electronApi.ipcRenderer.send('update-component-hover', 'live2d-model', currentHitState);
      }
    }
    // --- End Pet Hover Logic ---
  }, [isPet, isDragging, electronApi, canvasRef, getPointerModelCoordinates, updateMouseFollow]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const adapter = (window as any).getLAppAdapter?.();
    const model = adapter?.getModel();
    const view = LAppDelegate.getInstance().getView();

    if (isDragging) {
      // Finalize drag
      finalizeDragPosition();
    } else if (isPotentialTapRef.current && adapter && model && view && canvasRef.current) {
      // --- Tap Motion Logic ---
      const timeElapsed = Date.now() - mouseDownTimeRef.current;
      const deltaX = e.clientX - mouseDownPosRef.current.x;
      const deltaY = e.clientY - mouseDownPosRef.current.y;
      const distanceMoved = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Check if it qualifies as a tap (short duration, minimal movement)
      if (timeElapsed < TAP_DURATION_THRESHOLD_MS && distanceMoved < DRAG_DISTANCE_THRESHOLD_PX) {
        const allowTapMotion = modelInfo?.pointerInteractive !== false;

        if (allowTapMotion && modelInfo?.tapMotions) {
          // Use mouse down position for hit testing
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();
          const scale = canvas.width / canvas.clientWidth;
          const downX = (mouseDownPosRef.current.x - rect.left) * scale;
          const downY = (mouseDownPosRef.current.y - rect.top) * scale;
          const modelX = view._deviceToScreen.transformX(downX);
          const modelY = view._deviceToScreen.transformY(downY);

          const hitAreaName = model.anyhitTest(modelX, modelY);
          // Trigger tap motion using the specific hit area name or null for general body tap
          model.startTapMotion(hitAreaName, modelInfo.tapMotions);
        }
      }
      // --- End Tap Motion Logic ---
    }

    // Reset potential tap flag regardless of outcome
    isPotentialTapRef.current = false;
  }, [isDragging, canvasRef, modelInfo, finalizeDragPosition]);

  const handleMouseLeave = useCallback(() => {
    const hasGlobalCursorFollow = !isPet && Boolean(electronApi?.ipcRenderer?.invoke);
    if (!hasGlobalCursorFollow) {
      clearMouseAttentionFollow();
    }
    if (isDragging) {
      finalizeDragPosition();
    }

    if (isPet || !electronApi?.ipcRenderer?.invoke) {
      LAppLive2DManager.getInstance().onDrag(0.0, 0.0);
    }

    // Reset potential tap if mouse leaves before mouse up
    if (isPotentialTapRef.current) {
      isPotentialTapRef.current = false;
    }
    // --- Pet Hover Logic (Unchanged) ---
    if (isPet && electronApi && isHoveringModelRef.current) {
      isHoveringModelRef.current = false;
      electronApi.ipcRenderer.send('update-component-hover', 'live2d-model', false);
    }
  }, [isPet, isDragging, electronApi, finalizeDragPosition, clearMouseAttentionFollow]);

  useEffect(() => {
    const handleGlobalPointerRelease = () => {
      if (isDragging) {
        finalizeDragPosition();
      }
      isPotentialTapRef.current = false;
    };

    window.addEventListener('mouseup', handleGlobalPointerRelease);
    window.addEventListener('blur', handleGlobalPointerRelease);

    return () => {
      window.removeEventListener('mouseup', handleGlobalPointerRelease);
      window.removeEventListener('blur', handleGlobalPointerRelease);
    };
  }, [isDragging, finalizeDragPosition]);

  useEffect(() => {
    if (isPet || !electronApi?.ipcRenderer?.invoke) {
      return undefined;
    }

    let isDisposed = false;

    const syncCursorFollow = async () => {
      if (isDisposed || isDragging || isPotentialTapRef.current) {
        return;
      }

      if (performance.now() < localPointerPriorityUntilMsRef.current) {
        return;
      }

      try {
        const cursorPoint = await electronApi.ipcRenderer.invoke('get-cursor-window-point');
        if (!cursorPoint || isDisposed) {
          return;
        }

        updateMouseFollow(cursorPoint.x, cursorPoint.y);
      } catch (error) {
        console.error('Failed to sync global cursor for Live2D follow:', error);
      }
    };

    const intervalId = window.setInterval(() => {
      void syncCursorFollow();
    }, 33);

    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [isPet, isDragging, electronApi, updateMouseFollow]);

  useEffect(() => {
    if (!isPet && electronApi && isHoveringModelRef.current) {
      isHoveringModelRef.current = false;
    }
  }, [isPet, electronApi]);

  // Expose motion debugging functions to window for console testing
  useEffect(() => {
    const playMotion = (motionGroup: string, motionIndex: number = 0, priority: number = 3) => {
      const adapter = (window as any).getLAppAdapter?.();
      if (!adapter) {
        console.error('Live2D adapter not available');
        return false;
      }

      const model = adapter.getModel();
      if (!model) {
        console.error('Live2D model not available');
        return false;
      }

      try {
        console.log(`Playing motion: group="${motionGroup}", index=${motionIndex}, priority=${priority}`);
        const result = model.startMotion(motionGroup, motionIndex, priority);
        console.log('Motion start result:', result);
        return result;
      } catch (error) {
        console.error('Error playing motion:', error);
        return false;
      }
    };

    const playRandomMotion = (motionGroup: string, priority: number = 3) => {
      const adapter = (window as any).getLAppAdapter?.();
      if (!adapter) {
        console.error('Live2D adapter not available');
        return false;
      }

      const model = adapter.getModel();
      if (!model) {
        console.error('Live2D model not available');
        return false;
      }

      try {
        console.log(`Playing random motion from group: "${motionGroup}", priority=${priority}`);
        const result = model.startRandomMotion(motionGroup, priority);
        console.log('Random motion start result:', result);
        return result;
      } catch (error) {
        console.error('Error playing random motion:', error);
        return false;
      }
    };

    const getMotionInfo = () => {
      const adapter = (window as any).getLAppAdapter?.();
      if (!adapter) {
        console.error('Live2D adapter not available');
        return null;
      }

      const model = adapter.getModel();
      if (!model) {
        console.error('Live2D model not available');
        return null;
      }

      try {
        const motionGroups = [];
        const setting = model._modelSetting;
        if (setting) {
          // Get all motion groups
          const groups = setting._json?.FileReferences?.Motions;
          if (groups) {
            for (const groupName in groups) {
              const motions = groups[groupName];
              motionGroups.push({
                name: groupName,
                count: motions.length,
                motions: motions.map((motion: any, index: number) => ({
                  index,
                  file: motion.File
                }))
              });
            }
          }
        }
        
        console.log('Available motion groups:', motionGroups);
        return motionGroups;
      } catch (error) {
        console.error('Error getting motion info:', error);
        return null;
      }
    };

    // Expose to window for console access
    (window as any).Live2DDebug = {
      playMotion,
      playRandomMotion,
      getMotionInfo,
      // Helper functions
      help: () => {
        console.log(`
Live2D Motion Debug Functions:
- Live2DDebug.getMotionInfo() - Get all available motion groups and their motions
- Live2DDebug.playMotion(group, index, priority) - Play specific motion
- Live2DDebug.playRandomMotion(group, priority) - Play random motion from group  
- Live2DDebug.help() - Show this help

Example usage:
Live2DDebug.getMotionInfo()  // See available motions
Live2DDebug.playMotion("", 0)  // Play first motion from default group
Live2DDebug.playRandomMotion("")  // Play random motion from default group
        `);
      }
    };

    console.log('Live2D Debug functions exposed to window.Live2DDebug');
    console.log('Type Live2DDebug.help() for usage information');

    // Cleanup function
    return () => {
      delete (window as any).Live2DDebug;
    };
  }, []);

  return {
    position,
    isDragging,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseLeave,
    },
  };
};
