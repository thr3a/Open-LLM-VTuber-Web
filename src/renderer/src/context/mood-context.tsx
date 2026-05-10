import {
  createContext,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from 'react';

interface MoodContextValue {
  moodScore: number;
  setMoodScore: (score: number) => void;
}

const DEFAULT_MOOD_SCORE = 80;

const MoodContext = createContext<MoodContextValue | null>(null);

export function MoodProvider({ children }: { children: ReactNode }) {
  const [moodScore, setMoodScore] = useState<number>(DEFAULT_MOOD_SCORE);

  const contextValue = useMemo(
    () => ({
      moodScore,
      setMoodScore,
    }),
    [moodScore],
  );

  return (
    <MoodContext.Provider value={contextValue}>
      {children}
    </MoodContext.Provider>
  );
}

export function useMood(): MoodContextValue {
  const context = useContext(MoodContext);

  if (!context) {
    throw new Error('useMood must be used within a MoodProvider');
  }

  return context;
}
