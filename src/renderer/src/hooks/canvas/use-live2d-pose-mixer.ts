import { useEffect } from 'react';
import { getLive2DPoseMixerController } from '@/hooks/canvas/live2d-pose-mixer-controller';

/**
 * Installs the minimal pose/mixer skeleton into the Live2D update loop.
 *
 * This is intentionally small and coexists with existing expression/motion/lipsync logic.
 */
export const useLive2DPoseMixer = (modelUrl?: string) => {
  useEffect(() => {
    const controller = getLive2DPoseMixerController();
    controller.setModelUrl(modelUrl);
    controller.installDebugGlobals();

    let frameId = 0;
    let cancelled = false;

    const ensureRunnerInstalled = () => {
      if (cancelled) {
        return;
      }

      const lappAdapter = (window as any).getLAppAdapter?.();
      if (!lappAdapter || !controller.installRunner(lappAdapter)) {
        frameId = window.requestAnimationFrame(ensureRunnerInstalled);
      }
    };

    ensureRunnerInstalled();

    return () => {
      cancelled = true;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [modelUrl]);
};
