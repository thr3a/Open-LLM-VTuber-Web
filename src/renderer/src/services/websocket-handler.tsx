/* eslint-disable no-sparse-arrays */
/* eslint-disable react-hooks/exhaustive-deps */
// eslint-disable-next-line object-curly-newline
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { wsService, MessageEvent } from '@/services/websocket-service';
import {
  WebSocketContext, HistoryInfo, defaultWsUrl, defaultBaseUrl,
} from '@/context/websocket-context';
import { ModelInfo, useLive2DConfig } from '@/context/live2d-config-context';
import { useSubtitle } from '@/context/subtitle-context';
import { audioTaskQueue } from '@/utils/task-queue';
import { useAudioTask } from '@/hooks/utils/use-audio-task';
import { useBgUrl } from '@/context/bgurl-context';
import { useConfig } from '@/context/character-config-context';
import { useChatHistory } from '@/context/chat-history-context';
import { toaster } from '@/components/ui/toaster';
import { useVAD } from '@/context/vad-context';
import { AiState, useAiState } from "@/context/ai-state-context";
import { useLocalStorage } from '@/hooks/utils/use-local-storage';
import { useGroup } from '@/context/group-context';
import { useInterrupt } from '@/hooks/utils/use-interrupt';
import { useBrowser } from '@/context/browser-context';
import { useMood } from '@/context/mood-context';
import { getLive2DPoseMixerController } from '@/hooks/canvas/live2d-pose-mixer-controller';
import { LOGICAL_CHANNELS, PoseValues } from '@/live2d/mixer/logical-channels';
import { IdleBankConfig, IdlePlayCommand, normalizeIdleBankConfig } from '@/live2d/mixer/recorded-idle-driver';
import type { PoseLayerId } from '@/hooks/canvas/live2d-pose-mixer-controller';

function normalizeBackendPose(input: unknown): PoseValues {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const source = input as Record<string, unknown>;
  const values: PoseValues = {};

  LOGICAL_CHANNELS.forEach((channel) => {
    const value = source[channel];
    if (typeof value === 'number' && Number.isFinite(value)) {
      values[channel] = value;
    }
  });

  return values;
}

const MIXER_LAYER_IDS: PoseLayerId[] = [
  'idle_layer',
  'speech_layer',
  'backend_pose_layer',
  'mouse_attention_layer',
];

function normalizeMixerWeights(input: unknown): Partial<Record<PoseLayerId, number>> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const source = input as Record<string, unknown>;
  const weights: Partial<Record<PoseLayerId, number>> = {};
  MIXER_LAYER_IDS.forEach((layerId) => {
    const raw = source[layerId];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      weights[layerId] = raw;
    }
  });
  return weights;
}

function applyMixerWeights(
  controller: ReturnType<typeof getLive2DPoseMixerController>,
  payload: { mixer_weights?: unknown; mixer_weights_mode?: 'patch' | 'reset' | null | undefined },
): void {
  if (payload.mixer_weights_mode === 'reset') {
    controller.resetLayerWeights();
  }

  const nextWeights = normalizeMixerWeights(payload.mixer_weights);
  if (Object.keys(nextWeights).length > 0) {
    controller.patchLayerWeights(nextWeights);
  }
}

function hasConcreteIdleBankInActions(actions: MessageEvent['actions']): boolean {
  if (!actions) {
    return false;
  }

  if (actions.idle_bank && typeof actions.idle_bank === 'object') {
    return true;
  }

  return Array.isArray(actions.idle_list)
    && actions.idle_list.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function hasConcreteMixerWeightsInActions(actions: MessageEvent['actions']): boolean {
  if (!actions) {
    return false;
  }

  if (actions.mixer_weights_mode === 'reset') {
    return true;
  }

  return Object.keys(normalizeMixerWeights(actions.mixer_weights)).length > 0;
}

function resolveIdleBankFromActions(actions: MessageEvent['actions']): IdleBankConfig | null {
  if (!actions) {
    return null;
  }

  if ('idle_bank' in actions) {
    return normalizeIdleBankConfig(actions.idle_bank ?? null);
  }

  if (!('idle_list' in actions)) {
    return null;
  }

  const clips = Array.isArray(actions.idle_list)
    ? actions.idle_list
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((url) => ({ url: url.trim() }))
    : [];

  if (clips.length === 0) {
    return null;
  }

  return normalizeIdleBankConfig({
    clips,
    mode: actions.idle_mode ?? 'random_no_repeat',
  });
}

function resolveIdleBankFromMessage(message: MessageEvent): IdleBankConfig | null {
  if ('idle_bank' in message) {
    return normalizeIdleBankConfig(message.idle_bank ?? null);
  }

  if (!('idle_list' in message)) {
    return null;
  }

  const clips = Array.isArray(message.idle_list)
    ? message.idle_list
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((url) => ({ url: url.trim() }))
    : [];

  if (clips.length === 0) {
    return null;
  }

  return normalizeIdleBankConfig({
    clips,
    mode: message.idle_mode ?? 'random_no_repeat',
  });
}

function resolveIdleStateFromMessage(message: MessageEvent): string | null {
  const actionState = message.actions?.idle_state;
  if (typeof actionState === 'string' && actionState.trim()) {
    return actionState.trim();
  }

  if (typeof message.idle_state === 'string' && message.idle_state.trim()) {
    return message.idle_state.trim();
  }

  return null;
}

function resolveIdlePlayFromMessage(message: MessageEvent): IdlePlayCommand | string | null {
  if (message.actions && 'idle_play' in message.actions) {
    return message.actions.idle_play ?? null;
  }

  if ('idle_play' in message) {
    return message.idle_play ?? null;
  }

  return null;
}

function WebSocketHandler({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [wsState, setWsState] = useState<string>('CLOSED');
  const [wsUrl, setWsUrl] = useLocalStorage<string>('wsUrl', defaultWsUrl);
  const [baseUrl, setBaseUrl] = useLocalStorage<string>('baseUrl', defaultBaseUrl);
  const { aiState, setAiState, backendSynthComplete, setBackendSynthComplete } = useAiState();
  const { setModelInfo, setPersistentAppearance } = useLive2DConfig();
  const { setSubtitleText } = useSubtitle();
  const { clearResponse, setForceNewMessage, appendHumanMessage, appendOrUpdateToolCallMessage } = useChatHistory();
  const { addAudioTask } = useAudioTask({ managePlaybackCompletion: true });
  const bgUrlContext = useBgUrl();
  const { confUid, setConfName, setConfUid, setConfigFiles } = useConfig();
  const [pendingModelInfo, setPendingModelInfo] = useState<ModelInfo | undefined>(undefined);
  const { setSelfUid, setGroupMembers, setIsOwner } = useGroup();
  const { startMic, stopMic, autoStartMicOnConvEnd } = useVAD();
  const autoStartMicOnConvEndRef = useRef(autoStartMicOnConvEnd);
  const currentTurnIdRef = useRef<string | null>(null);
  const { interrupt } = useInterrupt();
  const { setBrowserViewData } = useBrowser();
  const { setMoodScore } = useMood();

  useEffect(() => {
    autoStartMicOnConvEndRef.current = autoStartMicOnConvEnd;
  }, [autoStartMicOnConvEnd]);

  useEffect(() => {
    if (pendingModelInfo && confUid) {
      setModelInfo(pendingModelInfo);
      setPendingModelInfo(undefined);
    }
  }, [pendingModelInfo, setModelInfo, confUid]);

  const {
    setCurrentHistoryUid, setMessages, setHistoryList,
  } = useChatHistory();

  const handleControlMessage = useCallback((message: MessageEvent) => {
    const controlText = message.text;
    switch (controlText) {
      case 'start-mic':
        console.log('Starting microphone...');
        startMic();
        break;
      case 'stop-mic':
        console.log('Stopping microphone...');
        stopMic();
        break;
      case 'conversation-chain-start':
        currentTurnIdRef.current = message.turn_id || null;
        setBackendSynthComplete(false);
        setAiState('thinking-speaking');
        audioTaskQueue.clearQueue();
        clearResponse();
        break;
      case 'conversation-chain-end':
        currentTurnIdRef.current = null;
        audioTaskQueue.addTask(() => new Promise<void>((resolve) => {
          setAiState((currentState: AiState) => {
            if (currentState === 'thinking-speaking') {
              // Auto start mic if enabled
              if (autoStartMicOnConvEndRef.current) {
                startMic();
              }
              return 'idle';
            }
            return currentState;
          });
          resolve();
        }));
        break;
      default:
        console.warn('Unknown control command:', controlText);
    }
  }, [clearResponse, setAiState, setBackendSynthComplete, startMic, stopMic]);

  const handleWebSocketMessage = useCallback((message: MessageEvent) => {
    console.log('Received message from server:', message);

    // Minimal backend -> mixer bridge (P1.5): if the backend sends logical pose in actions,
    // route it into backend_pose_layer only. This intentionally does NOT touch expressions/motions.
    if (message.actions && ('pose' in message.actions || 'pose_patch' in message.actions)) {
      const controller = getLive2DPoseMixerController();
      const hasPosePatch = 'pose_patch' in message.actions;
      const mode = message.actions.pose_mode ?? 'set';
      const weight = typeof message.actions.pose_weight === 'number' && Number.isFinite(message.actions.pose_weight)
        ? message.actions.pose_weight
        : undefined;

      if (mode === 'clear' || message.actions.pose === null || message.actions.pose_patch === null) {
        controller.clearBackendPose();
      } else if (mode === 'patch' || hasPosePatch) {
        // `patch` preserves previous backend channels and updates only provided keys.
        // `pose_patch` defaults to patch semantics for streaming/incremental backends.
        const patchPose = hasPosePatch ? message.actions.pose_patch : message.actions.pose;
        controller.patchBackendPose(normalizeBackendPose(patchPose), weight);
      } else {
        // Default `set` is safer for full-pose payloads to avoid stale channel carry-over.
        controller.setBackendPose(normalizeBackendPose(message.actions.pose), weight);
      }
    }

    if (message.actions && hasConcreteIdleBankInActions(message.actions)) {
      const controller = getLive2DPoseMixerController();
      const idleBank = resolveIdleBankFromActions(message.actions);
      controller.setIdleRuntimeState(resolveIdleStateFromMessage(message));
      if (idleBank) {
        controller.setRecordedIdleBank(idleBank);
      }
    }

    if (message.actions && hasConcreteMixerWeightsInActions(message.actions)) {
      const controller = getLive2DPoseMixerController();
      controller.setIdleRuntimeState(resolveIdleStateFromMessage(message));
      applyMixerWeights(controller, {
        mixer_weights: message.actions.mixer_weights,
        mixer_weights_mode: message.actions.mixer_weights_mode,
      });
    }

    if (message.type === 'set-live2d-mixer-weights' || 'mixer_weights' in message || message.mixer_weights_mode === 'reset') {
      const controller = getLive2DPoseMixerController();
      controller.setIdleRuntimeState(resolveIdleStateFromMessage(message));
      applyMixerWeights(controller, {
        mixer_weights: message.mixer_weights,
        mixer_weights_mode: message.mixer_weights_mode,
      });
    }

    if (message.type === 'set-live2d-idle-bank') {
      const controller = getLive2DPoseMixerController();
      controller.setIdleRuntimeState(resolveIdleStateFromMessage(message));
      const idleBank = resolveIdleBankFromMessage(message);
      if (idleBank) {
        controller.setRecordedIdleBank(idleBank);
      } else {
        controller.clearRecordedIdleBank();
      }
    }

    if (
      (message.actions && 'idle_play' in message.actions)
      || message.type === 'set-live2d-idle-play'
      || 'idle_play' in message
    ) {
      const controller = getLive2DPoseMixerController();
      controller.setIdleRuntimeState(resolveIdleStateFromMessage(message));
      controller.playRecordedIdleClip(resolveIdlePlayFromMessage(message));
    }

    switch (message.type) {
      case 'control':
        handleControlMessage(message);
        break;
      case 'pose':
      case 'live2d-pose':
        // `actions.pose` is handled above (P1 mixer bridge).
        break;
      case 'set-live2d-idle-bank':
        // handled above as a dedicated live2d control message.
        break;
      case 'set-live2d-mixer-weights':
        // handled above as a dedicated live2d control message.
        break;
      case 'set-live2d-idle-play':
        // handled above as a dedicated recorded-idle trigger.
        break;
      case 'set-model-and-conf':
        setAiState('loading');
        if (message.conf_name) {
          setConfName(message.conf_name);
        }
        if (message.conf_uid) {
          setConfUid(message.conf_uid);
          console.log('confUid', message.conf_uid);
        }
        if (message.client_uid) {
          setSelfUid(message.client_uid);
        }
        setPendingModelInfo(message.model_info);
        // setModelInfo(message.model_info);
        // We don't know when the confRef in live2d-config-context will be updated, so we set a delay here for convenience
        if (message.model_info && !message.model_info.url.startsWith("http")) {
          const modelUrl = baseUrl + message.model_info.url;
          // eslint-disable-next-line no-param-reassign
          message.model_info.url = modelUrl;
        }

        setAiState('idle');
        break;
      case 'full-text':
        if (message.text) {
          setSubtitleText(message.text);
        }
        break;
      case 'mood-update':
        if (typeof message.score === 'number' && Number.isFinite(message.score)) {
          setMoodScore(Math.min(100, Math.max(0, message.score)));
        }
        break;
      case 'config-files':
        if (message.configs) {
          setConfigFiles(message.configs);
        }
        break;
      case 'config-switched':
        setAiState('idle');
        setSubtitleText(t('notification.characterLoaded'));

        toaster.create({
          title: t('notification.characterSwitched'),
          type: 'success',
          duration: 2000,
        });

        // setModelInfo(undefined);

        wsService.sendMessage({ type: 'fetch-history-list' });
        wsService.sendMessage({ type: 'create-new-history' });
        break;
      case 'background-files':
        if (message.files) {
          bgUrlContext?.setBackgroundFiles(message.files);
        }
        break;
      case 'audio':
        if (message.turn_id && currentTurnIdRef.current && message.turn_id !== currentTurnIdRef.current) {
          console.log('Dropping stale audio payload for old turn:', message.turn_id);
          break;
        }
        if (aiState === 'interrupted' || aiState === 'listening') {
          console.log('Audio playback intercepted. Sentence:', message.display_text?.text);
        } else {
          console.log("actions", message.actions);
          addAudioTask({
            audioBase64: message.audio || '',
            volumes: message.volumes || [],
            sliceLength: message.slice_length || 0,
            displayText: message.display_text || null,
            expressions: message.actions?.expressions || null,
            forwarded: message.forwarded || false,
            turnId: message.turn_id,
            ttsError: Boolean(message.tts_error),
          });
        }
        break;
      case 'history-data':
        if (message.messages) {
          setMessages(message.messages);
        }
        toaster.create({
          title: t('notification.historyLoaded'),
          type: 'success',
          duration: 2000,
        });
        break;
      case 'new-history-created':
        setAiState('idle');
        setSubtitleText(t('notification.newConversation'));
        // No need to open mic here
        if (message.history_uid) {
          setCurrentHistoryUid(message.history_uid);
          setMessages([]);
          const newHistory: HistoryInfo = {
            uid: message.history_uid,
            latest_message: null,
            timestamp: new Date().toISOString(),
          };
          setHistoryList((prev: HistoryInfo[]) => [newHistory, ...prev]);
          toaster.create({
            title: t('notification.newChatHistory'),
            type: 'success',
            duration: 2000,
          });
        }
        break;
      case 'history-deleted':
        toaster.create({
          title: message.success
            ? t('notification.historyDeleteSuccess')
            : t('notification.historyDeleteFail'),
          type: message.success ? 'success' : 'error',
          duration: 2000,
        });
        break;
      case 'history-list':
        if (message.histories) {
          setHistoryList(message.histories);
          if (message.histories.length > 0) {
            setCurrentHistoryUid(message.histories[0].uid);
          }
        }
        break;
      case 'user-input-transcription':
        console.log('user-input-transcription: ', message.text);
        if (message.text) {
          appendHumanMessage(message.text);
        }
        break;
      case 'error':
        toaster.create({
          title: message.message,
          type: 'error',
          duration: 2000,
        });
        break;
      case 'group-update':
        console.log('Received group-update:', message.members);
        if (message.members) {
          setGroupMembers(message.members);
        }
        if (message.is_owner !== undefined) {
          setIsOwner(message.is_owner);
        }
        break;
      case 'group-operation-result':
        toaster.create({
          title: message.message,
          type: message.success ? 'success' : 'error',
          duration: 2000,
        });
        break;
      case 'backend-synth-complete':
        if (!message.turn_id || !currentTurnIdRef.current || message.turn_id === currentTurnIdRef.current) {
          setBackendSynthComplete(true);
        }
        break;
      case 'conversation-chain-end':
        if (!audioTaskQueue.hasTask()) {
          setAiState((currentState: AiState) => {
            if (currentState === 'thinking-speaking') {
              return 'idle';
            }
            return currentState;
          });
        }
        break;
      case 'force-new-message':
        setForceNewMessage(true);
        break;
      case 'interrupt-signal':
        // Handle forwarded interrupt
        interrupt(false); // do not send interrupt signal to server
        break;
      case 'tool_call_status':
        if (message.tool_id && message.tool_name && message.status) {
          // If there's browser view data included, store it in the browser context
          if (message.browser_view) {
            console.log('Browser view data received:', message.browser_view);
            setBrowserViewData(message.browser_view);
          }

          appendOrUpdateToolCallMessage({
            id: message.tool_id,
            type: 'tool_call_status',
            role: 'ai',
            tool_id: message.tool_id,
            tool_name: message.tool_name,
            name: message.name,
            status: message.status as ('running' | 'completed' | 'error'),
            content: message.content || '',
            timestamp: message.timestamp || new Date().toISOString(),
          });
        } else {
          console.warn('Received incomplete tool_call_status message:', message);
        }
        break;
      case 'set-live2d-appearance': {
        if (typeof message.expression === 'string') {
          setPersistentAppearance(message.expression);
        }
        break;
      }
      default:
        console.warn('Unknown message type:', message.type);
    }
  }, [aiState, addAudioTask, appendHumanMessage, baseUrl, bgUrlContext, setAiState, setConfName, setConfUid, setConfigFiles, setCurrentHistoryUid, setHistoryList, setMessages, setModelInfo, setPersistentAppearance, setSubtitleText, startMic, stopMic, setSelfUid, setGroupMembers, setIsOwner, backendSynthComplete, setBackendSynthComplete, clearResponse, handleControlMessage, appendOrUpdateToolCallMessage, interrupt, setBrowserViewData, setMoodScore, t]);

  useEffect(() => {
    wsService.connect(wsUrl);
  }, [wsUrl]);

  useEffect(() => {
    const stateSubscription = wsService.onStateChange(setWsState);
    const messageSubscription = wsService.onMessage(handleWebSocketMessage);
    return () => {
      stateSubscription.unsubscribe();
      messageSubscription.unsubscribe();
    };
  }, [wsUrl, handleWebSocketMessage]);

  const webSocketContextValue = useMemo(() => ({
    sendMessage: wsService.sendMessage.bind(wsService),
    wsState,
    reconnect: () => wsService.connect(wsUrl),
    disconnect: () => wsService.disconnect(),
    wsUrl,
    setWsUrl,
    baseUrl,
    setBaseUrl,
  }), [wsState, wsUrl, baseUrl]);

  return (
    <WebSocketContext.Provider value={webSocketContextValue}>
      {children}
    </WebSocketContext.Provider>
  );
}

export default WebSocketHandler;
