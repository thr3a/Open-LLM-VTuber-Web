import { useMemo, useCallback } from 'react';
import { useWebSocket } from '@/context/websocket-context';

interface WSStatusInfo {
  color: string
  textKey: string
  isDisconnected: boolean
  isClickable: boolean
  handleClick: () => void
}

export const useWSStatus = () => {
  const { wsState, reconnect, disconnect } = useWebSocket();

  const handleClick = useCallback(() => {
    if (wsState === 'OPEN') {
      disconnect();
      return;
    }

    if (wsState !== 'CONNECTING') {
      reconnect();
    }
  }, [wsState, reconnect, disconnect]);

  const statusInfo = useMemo((): WSStatusInfo => {
    switch (wsState) {
      case 'OPEN':
        return {
          color: 'green.500',
          textKey: 'wsStatus.connected',
          isDisconnected: false,
          isClickable: true,
          handleClick,
        };
      case 'CONNECTING':
        return {
          color: 'yellow.500',
          textKey: 'wsStatus.connecting',
          isDisconnected: false,
          isClickable: false,
          handleClick,
        };
      default:
        return {
          color: 'red.500',
          textKey: 'wsStatus.clickToReconnect',
          isDisconnected: true,
          isClickable: true,
          handleClick,
        };
    }
  }, [wsState, handleClick]);

  return statusInfo;
};
