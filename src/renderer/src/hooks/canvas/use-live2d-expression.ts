import { useCallback } from 'react';
import { ModelInfo } from '@/context/live2d-config-context';
import {
  ExpressionSelector,
  getLive2DParameterLayerController,
} from '@/hooks/canvas/live2d-parameter-layer-controller';

/**
 * Custom hook for handling transient Live2D expressions.
 */
export const useLive2DExpression = () => {
  /**
   * Queue a transient expression patch.
   * The adapter argument is kept for compatibility with the existing call sites.
   */
  const setExpression = useCallback((
    expressionValue: ExpressionSelector,
    _lappAdapter?: any,
    logMessage?: string,
  ) => {
    getLive2DParameterLayerController().requestTransientExpression(expressionValue, logMessage);
  }, []);

  /**
   * Clear the transient expression layer so the model returns to its base appearance.
   * The existing signature is preserved for compatibility.
   */
  const resetExpression = useCallback((
    _lappAdapter?: any,
    _modelInfo?: ModelInfo,
  ) => {
    getLive2DParameterLayerController().clearTransientExpression(
      'Cleared transient expression and returned to base appearance',
    );
  }, []);

  return {
    setExpression,
    resetExpression,
  };
};
