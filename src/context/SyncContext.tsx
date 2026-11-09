/**
 * Sync Context for ONE TEAM
 *
 * Provides real-time synchronization state, metrics, and triggers across all UI modules.
 */

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { syncEngine, SyncStatusMetrics } from '../services/syncEngine';
import { useAuth } from './AuthContext';

export interface SyncContextType extends SyncStatusMetrics {
  syncNow: () => Promise<void>;
  isStorageReady: boolean;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isStorageReady, currentWorkspace } = useAuth();
  const [metrics, setMetrics] = useState<SyncStatusMetrics>(() => syncEngine.getMetrics());

  useEffect(() => {
    // Subscribe to engine metrics updates
    const unsubscribe = syncEngine.subscribe((updated) => {
      setMetrics(updated);
    });

    return () => unsubscribe();
  }, []);

  // Lifecycle coordination with workspace transitions
  useEffect(() => {
    if (isStorageReady && currentWorkspace?.id) {
      syncEngine.start();
    } else {
      syncEngine.stop();
    }

    return () => {
      syncEngine.stop();
    };
  }, [isStorageReady, currentWorkspace?.id]);

  const syncNow = async () => {
    await syncEngine.syncNow();
  };

  return (
    <SyncContext.Provider
      value={{
        ...metrics,
        syncNow,
        isStorageReady,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
};

export const useSync = (): SyncContextType => {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return context;
};
