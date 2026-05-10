import { Box, Text } from '@chakra-ui/react';
import { useTranslation } from 'react-i18next';
import { useAiState } from '@/context/ai-state-context';
import { useMood } from '@/context/mood-context';
import { footerStyles } from './footer-styles';

function getMoodPresentation(score: number) {
  if (score >= 90) {
    return { emoji: '😊', label: 'excited' };
  }
  if (score >= 80) {
    return { emoji: '🙂', label: 'normal' };
  }
  if (score >= 60) {
    return { emoji: '😔', label: 'low' };
  }
  return { emoji: '😶', label: 'silent' };
}

function AIStateIndicator(): JSX.Element {
  const { t } = useTranslation();
  const { aiState } = useAiState();
  const { moodScore } = useMood();
  const styles = footerStyles.aiIndicator;
  const mood = getMoodPresentation(moodScore);
  const moodDescription = `Mood: ${mood.label} (${moodScore})`;

  return (
    <Box
      {...styles.container}
      px="3"
      gap="2"
      title={moodDescription}
    >
      <Text {...styles.text}>{t(`aiState.${aiState}`)}</Text>
      <Text
        fontSize="14px"
        lineHeight="1"
        aria-label={moodDescription}
      >
        {mood.emoji}
      </Text>
      <Text
        fontSize="11px"
        lineHeight="1"
        color="whiteAlpha.900"
        fontVariantNumeric="tabular-nums"
        aria-hidden="true"
      >
        {moodScore}
      </Text>
    </Box>
  );
}

export default AIStateIndicator;
