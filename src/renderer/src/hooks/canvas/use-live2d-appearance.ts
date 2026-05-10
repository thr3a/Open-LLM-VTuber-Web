import { useEffect } from 'react';
import { ModelInfo } from '@/context/live2d-config-context';
import { getLive2DParameterLayerController } from '@/hooks/canvas/live2d-parameter-layer-controller';

export const useLive2DAppearance = (
  modelInfo?: ModelInfo,
  persistentAppearance?: string,
) => {
  useEffect(() => {
    const controller = getLive2DParameterLayerController();
    controller.syncBaseAppearance(modelInfo, persistentAppearance);
  }, [modelInfo, persistentAppearance]);

  useEffect(() => {
    const controller = getLive2DParameterLayerController();
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
  }, [modelInfo?.url]);
};
