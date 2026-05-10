import { ModelInfo } from '@/context/live2d-config-context';

export type ExpressionBlend = 'Add' | 'Multiply' | 'Overwrite';
export type ExpressionSelector = string | number;

interface ExpressionReference {
  Name?: string;
  File?: string;
}

interface ExpressionParameter {
  Id?: string;
  Value?: number;
  Blend?: string;
}

interface ExpressionFile {
  Parameters?: ExpressionParameter[];
}

interface Model3File {
  FileReferences?: {
    Expressions?: ExpressionReference[];
  };
}

interface ResolvedExpressionReference {
  expressionName: string;
  fileUrl: string;
}

interface AppearanceOperation {
  id: string;
  value: number;
  blend: ExpressionBlend;
}

export interface AppearancePatch {
  expressionName: string;
  operations: AppearanceOperation[];
}

interface PatchedModel {
  _parameterLayerController?: {
    controller: Live2DParameterLayerController;
    originalUpdate: () => void;
  };
  _model?: {
    addParameterValueById: (id: unknown, value: number, weight?: number) => void;
    multiplyParameterValueById: (id: unknown, value: number, weight?: number) => void;
    setParameterValueById: (id: unknown, value: number, weight?: number) => void;
    update: () => void;
  };
  update: () => void;
}

const expressionCatalogCache = new Map<string, Promise<ResolvedExpressionReference[]>>();
const appearancePatchCache = new Map<string, Promise<AppearancePatch | null>>();

// Keep persistent orientation/attention controls under mixer governance.
// Appearance/expression patches can still shape face style, but should not own these channels.
const MIXER_OWNED_PARAMETER_IDS = new Set([
  'ParamAngleX',
  'ParamAngleX2',
  'ParamAngleX3',
  'ParamAngleY',
  'ParamAngleY2',
  'ParamAngleY3',
  'ParamAngleZ',
  'ParamAngleZ2',
  'ParamBodyAngleX',
  'ParamBodyAngleY',
  'ParamBodyAngleZ',
  'bodyX',
  'bodyX2',
  'bodyX3',
  'bodyY',
  'bodyZ',
  'bodyZ2',
  'bodyZZ',
  'bodyZZ2',
  'ParamEyeBallX',
  'ParamEyeBallY',
]);

function isMixerOwnedParameter(parameterId: string): boolean {
  return MIXER_OWNED_PARAMETER_IDS.has(parameterId);
}

function normalizeBlend(blend: string | undefined): ExpressionBlend {
  if (blend === 'Add' || blend === 'Multiply' || blend === 'Overwrite') {
    return blend;
  }
  return 'Overwrite';
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function resolveAssetUrl(modelUrl: string, relativePath: string): string {
  return new URL(relativePath, modelUrl).toString();
}

async function getExpressionCatalog(modelUrl: string): Promise<ResolvedExpressionReference[]> {
  const cached = expressionCatalogCache.get(modelUrl);
  if (cached) {
    return cached;
  }

  const loader = (async () => {
    const model3 = await fetchJson<Model3File>(modelUrl);
    return (model3.FileReferences?.Expressions ?? [])
      .filter((expression): expression is ExpressionReference & { Name: string; File: string } =>
        typeof expression.Name === 'string' && typeof expression.File === 'string')
      .map((expression) => ({
        expressionName: expression.Name,
        fileUrl: resolveAssetUrl(modelUrl, expression.File),
      }));
  })();

  expressionCatalogCache.set(modelUrl, loader);
  return loader;
}

async function resolveExpressionReference(
  modelInfo: ModelInfo,
  selector: ExpressionSelector,
): Promise<ResolvedExpressionReference | null> {
  const catalog = await getExpressionCatalog(modelInfo.url);

  if (typeof selector === 'number') {
    return catalog[selector] ?? null;
  }

  return catalog.find((entry) => entry.expressionName === selector) ?? null;
}

export async function resolveAppearancePatch(
  modelInfo: ModelInfo,
  selector: ExpressionSelector,
): Promise<AppearancePatch | null> {
  const reference = await resolveExpressionReference(modelInfo, selector);
  if (!reference) {
    return null;
  }

  const cacheKey = `${modelInfo.url}::${reference.expressionName}`;
  const cached = appearancePatchCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loader = (async () => {
    const expressionFile = await fetchJson<ExpressionFile>(reference.fileUrl);
    return {
      expressionName: reference.expressionName,
      operations: (expressionFile.Parameters ?? [])
        .filter((parameter): parameter is ExpressionParameter & { Id: string; Value: number } =>
          typeof parameter.Id === 'string' && typeof parameter.Value === 'number')
        .filter((parameter) => !isMixerOwnedParameter(parameter.Id))
        .map((parameter) => ({
          id: parameter.Id,
          value: parameter.Value,
          blend: normalizeBlend(parameter.Blend),
        })),
    };
  })();

  appearancePatchCache.set(cacheKey, loader);
  return loader;
}

function applyPatchOperations(
  model: PatchedModel,
  lappAdapter: any,
  patches: AppearancePatch[],
): boolean {
  if (!model._model || patches.length === 0) {
    return false;
  }

  const idManager = lappAdapter.getIdManager?.();
  if (!idManager?.getId) {
    return false;
  }

  let applied = false;

  patches.forEach((patch) => {
    patch.operations.forEach((operation) => {
      const parameterId = idManager.getId(operation.id);
      switch (operation.blend) {
        case 'Add':
          model._model?.addParameterValueById(parameterId, operation.value, 1);
          break;
        case 'Multiply':
          model._model?.multiplyParameterValueById(parameterId, operation.value, 1);
          break;
        case 'Overwrite':
        default:
          model._model?.setParameterValueById(parameterId, operation.value, 1);
          break;
      }
      applied = true;
    });
  });

  return applied;
}

class Live2DParameterLayerController {
  private modelInfo?: ModelInfo;

  private basePatches: AppearancePatch[] = [];

  private baseLoadVersion = 0;

  private transientRequestVersion = 0;

  private requestedTransientSelector: ExpressionSelector | null = null;

  private pendingTransientPatch: AppearancePatch | null | undefined = undefined;

  private activeTransientPatch: AppearancePatch | null = null;

  public syncBaseAppearance(modelInfo?: ModelInfo, persistentAppearance?: string): void {
    const previousModelUrl = this.modelInfo?.url;
    const nextModelUrl = modelInfo?.url;
    const modelChanged = previousModelUrl !== nextModelUrl;

    this.modelInfo = modelInfo;

    if (modelChanged) {
      this.basePatches = [];
      this.activeTransientPatch = null;
      if (this.requestedTransientSelector !== null) {
        this.pendingTransientPatch = undefined;
      }
    }

    const loadVersion = ++this.baseLoadVersion;

    if (!modelInfo) {
      this.basePatches = [];
      return;
    }

    void this.loadBasePatches(loadVersion, modelInfo, persistentAppearance);

    if (modelChanged && this.requestedTransientSelector !== null) {
      void this.resolveTransientPatch(
        this.transientRequestVersion,
        this.requestedTransientSelector,
        modelInfo,
      );
    }
  }

  public requestTransientExpression(selector: ExpressionSelector, logMessage?: string): void {
    this.transientRequestVersion += 1;
    this.requestedTransientSelector = selector;
    this.pendingTransientPatch = undefined;

    if (logMessage) {
      console.log(logMessage);
    }

    if (!this.modelInfo) {
      return;
    }

    void this.resolveTransientPatch(this.transientRequestVersion, selector, this.modelInfo);
  }

  public clearTransientExpression(logMessage?: string): void {
    this.transientRequestVersion += 1;
    this.requestedTransientSelector = null;
    this.pendingTransientPatch = undefined;
    this.activeTransientPatch = null;

    if (logMessage) {
      console.log(logMessage);
    }
  }

  public installRunner(lappAdapter: any): boolean {
    const model = lappAdapter?.getModel?.() as PatchedModel | null | undefined;
    if (!model || !model._model || typeof model.update !== 'function') {
      return false;
    }

    const existingRunner = model._parameterLayerController;
    if (existingRunner?.controller === this) {
      return true;
    }

    const originalUpdate = existingRunner?.originalUpdate ?? model.update.bind(model);
    model._parameterLayerController = {
      controller: this,
      originalUpdate,
    };

    model.update = () => {
      const runner = model._parameterLayerController;
      runner?.originalUpdate();

      // Keep the layering order stable: native Live2D update first, then base, then transient.
      const appliedAnyPatch = this.applyLayers(model, lappAdapter);
      if (appliedAnyPatch) {
        model._model?.update();
      }
    };

    return true;
  }

  private async loadBasePatches(
    loadVersion: number,
    modelInfo: ModelInfo,
    persistentAppearance?: string,
  ): Promise<void> {
    try {
      const selectors: ExpressionSelector[] = [];

      if (modelInfo.defaultEmotion !== undefined) {
        selectors.push(modelInfo.defaultEmotion);
      }

      if (persistentAppearance) {
        selectors.push(persistentAppearance);
      }

      const patchMap = new Map<string, AppearancePatch>();
      const resolvedPatches = await Promise.all(
        selectors.map((selector) => resolveAppearancePatch(modelInfo, selector)),
      );

      if (loadVersion !== this.baseLoadVersion || this.modelInfo?.url !== modelInfo.url) {
        return;
      }

      resolvedPatches.forEach((patch) => {
        if (patch) {
          patchMap.set(patch.expressionName, patch);
        }
      });

      this.basePatches = Array.from(patchMap.values());
    } catch (error) {
      if (loadVersion !== this.baseLoadVersion) {
        return;
      }

      console.warn('Failed to load Live2D base appearance patches:', error);
      this.basePatches = [];
    }
  }

  private async resolveTransientPatch(
    requestVersion: number,
    selector: ExpressionSelector,
    modelInfo: ModelInfo,
  ): Promise<void> {
    try {
      const patch = await resolveAppearancePatch(modelInfo, selector);
      if (!this.isCurrentTransientRequest(requestVersion, selector, modelInfo.url)) {
        return;
      }

      this.pendingTransientPatch = patch;
    } catch (error) {
      if (!this.isCurrentTransientRequest(requestVersion, selector, modelInfo.url)) {
        return;
      }

      console.warn('Failed to resolve Live2D transient expression patch:', error);
      this.pendingTransientPatch = null;
    }
  }

  private isCurrentTransientRequest(
    requestVersion: number,
    selector: ExpressionSelector,
    modelUrl: string,
  ): boolean {
    return requestVersion === this.transientRequestVersion
      && this.requestedTransientSelector === selector
      && this.modelInfo?.url === modelUrl;
  }

  private commitPendingTransientIfReady(): void {
    if (this.requestedTransientSelector === null || this.pendingTransientPatch === undefined) {
      return;
    }

    // Requests stay pending until a wrapped model update can safely commit them.
    this.activeTransientPatch = this.pendingTransientPatch;
    this.pendingTransientPatch = undefined;
  }

  private applyLayers(model: PatchedModel, lappAdapter: any): boolean {
    this.commitPendingTransientIfReady();

    const appliedBase = applyPatchOperations(model, lappAdapter, this.basePatches);
    const appliedTransient = this.activeTransientPatch
      ? applyPatchOperations(model, lappAdapter, [this.activeTransientPatch])
      : false;

    return appliedBase || appliedTransient;
  }
}

const live2DParameterLayerController = new Live2DParameterLayerController();

export function getLive2DParameterLayerController(): Live2DParameterLayerController {
  return live2DParameterLayerController;
}
