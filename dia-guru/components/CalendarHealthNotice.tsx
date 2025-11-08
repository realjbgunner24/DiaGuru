import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { CalendarHealth } from '@/lib/google-connect';

type Props = {
  health: CalendarHealth | null;
  error: string | null;
  checking: boolean;
  onReconnect: () => void;
  onRetry: () => void;
};

export function CalendarHealthNotice({
  health,
  error,
  checking,
  onReconnect,
  onRetry,
}: Props) {
  const showBanner = health?.status === 'needs_reconnect';
  const showError = Boolean(error);

  if (!showBanner && !showError) {
    return null;
  }

  return (
    <View style={styles.container}>
      {showError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Calendar check failed</Text>
          <Text style={styles.errorText}>
            {error ?? 'We could not verify your Google Calendar link right now.'}
          </Text>
          <TouchableOpacity
            onPress={onRetry}
            style={[styles.retryButton, checking && styles.retryButtonDisabled]}
            disabled={checking}
            accessibilityRole="button"
          >
            <Text style={styles.retryButtonText}>{checking ? 'Retrying…' : 'Try again'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {showBanner ? (
        <View style={styles.bannerBox}>
          <View style={styles.bannerHeader}>
            <Text style={styles.bannerTitle}>Reconnect Google Calendar</Text>
            {checking ? <ActivityIndicator size="small" color="#92400E" /> : null}
          </View>
          <Text style={styles.bannerText}>
            DiaGuru needs access to your calendar to plan sessions automatically. Reconnect now to
            resume scheduling.
          </Text>
          <View style={styles.bannerActions}>
            <TouchableOpacity
              onPress={onReconnect}
              style={styles.bannerPrimary}
              accessibilityRole="button"
            >
              <Text style={styles.bannerPrimaryText}>Reconnect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onRetry}
              style={[styles.bannerSecondary, checking && styles.bannerSecondaryDisabled]}
              disabled={checking}
              accessibilityRole="button"
            >
              <Text style={styles.bannerSecondaryText}>Check again</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    marginBottom: 16,
  },
  errorBox: {
    backgroundColor: '#FEE2E2',
    borderColor: '#EF4444',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  errorTitle: {
    fontWeight: '700',
    color: '#991B1B',
    fontSize: 15,
  },
  errorText: {
    color: '#7F1D1D',
    fontSize: 13,
  },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#991B1B',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  retryButtonDisabled: {
    backgroundColor: '#B91C1C',
    opacity: 0.7,
  },
  retryButtonText: {
    color: '#FEE2E2',
    fontWeight: '600',
  },
  bannerBox: {
    backgroundColor: '#FEF3C7',
    borderColor: '#F59E0B',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  bannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bannerTitle: {
    fontWeight: '700',
    color: '#92400E',
    fontSize: 15,
    flex: 1,
  },
  bannerText: {
    color: '#92400E',
    fontSize: 13,
    lineHeight: 18,
  },
  bannerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  bannerPrimary: {
    backgroundColor: '#F59E0B',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    flexShrink: 0,
  },
  bannerPrimaryText: {
    fontWeight: '700',
    color: '#1F2937',
  },
  bannerSecondary: {
    borderWidth: 1,
    borderColor: '#F59E0B',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    flexShrink: 0,
  },
  bannerSecondaryDisabled: {
    opacity: 0.6,
  },
  bannerSecondaryText: {
    fontWeight: '600',
    color: '#92400E',
  },
});

export default CalendarHealthNotice;
