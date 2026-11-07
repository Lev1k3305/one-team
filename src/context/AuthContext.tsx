import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../services/supabaseClient';
import { authService, UserProfile } from '../services/authService';
import { workspaceService, Workspace, WorkspaceMember } from '../services/workspaceService';
import {
  StorageContext,
  SessionGenerationManager,
  sessionGenerationManager,
} from '../services/storageContext';
import { storageServiceAdapter } from '../services/storageAdapter';

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentRole: 'owner' | 'admin' | 'editor' | 'viewer';
  isLoading: boolean;
  needsEmailVerification: boolean;
  setNeedsEmailVerification: (val: boolean) => void;
  signUp: (email: string, pass: string, name: string) => Promise<any>;
  signIn: (email: string, pass: string) => Promise<any>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<any>;
  updatePassword: (pass: string) => Promise<any>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (name: string, description?: string, avatar?: string) => Promise<Workspace>;
  refreshWorkspaces: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;

  // Foundation Fix 01 integrations
  storageContext: StorageContext;
  sessionGeneration: number;
  isStorageReady: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [currentRole, setCurrentRole] = useState<'owner' | 'admin' | 'editor' | 'viewer'>('owner');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [needsEmailVerification, setNeedsEmailVerification] = useState<boolean>(false);

  // Storage context & generation states
  const [storageContext, setStorageContext] = useState<StorageContext>(() =>
    sessionGenerationManager.getContext()
  );
  const [sessionGeneration, setSessionGeneration] = useState<number>(() =>
    sessionGenerationManager.getGeneration()
  );
  const [isStorageReady, setIsStorageReady] = useState<boolean>(false);

  // Race condition guards
  const lastEventTimestamp = useRef<number>(0);
  const isSignedOutRef = useRef<boolean>(false);
  const authEventHandledRef = useRef<boolean>(false);

  /**
   * Synchronizes storage adapter with new StorageContext and awaits hydration.
   */
  const syncStorage = useCallback(async (ctx: StorageContext) => {
    setStorageContext(ctx);
    setSessionGeneration(ctx.sessionGeneration);
    setIsStorageReady(false);

    try {
      await storageServiceAdapter.switchContext(ctx);
      // Ensure we only mark ready if context didn't change while awaiting
      if (sessionGenerationManager.getGeneration() === ctx.sessionGeneration) {
        setIsStorageReady(true);
      }
    } catch (e) {
      console.warn('[AuthContext] Storage hydration notice:', e);
    }
  }, []);

  const loadUserWorkspaces = useCallback(async (userId: string, generationExpected: number) => {
    try {
      const list = await workspaceService.getUserWorkspaces(userId);
      // Guard against race condition: if session generation changed, discard
      if (sessionGenerationManager.getGeneration() !== generationExpected) {
        return null;
      }

      setWorkspaces(list);

      const savedWsId = typeof localStorage !== 'undefined' ? localStorage.getItem('oneteam_active_ws_id') : null;
      let matched = list.find((w) => w.id === savedWsId);
      if (!matched && list.length > 0) {
        matched = list[0];
      }

      if (matched) {
        setCurrentWorkspace(matched);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('oneteam_active_ws_id', matched.id);
        }
        // Fetch role in current workspace
        const members = await workspaceService.getWorkspaceMembers(matched.id);
        const myMember = members.find((m) => m.userId === userId);
        if (myMember) {
          setCurrentRole(myMember.role);
        }
        return matched;
      } else {
        setCurrentWorkspace(null);
        return null;
      }
    } catch (err) {
      console.warn('[AuthContext] Failed to load workspaces:', err);
      return null;
    }
  }, []);

  const loadUserProfile = useCallback(async (u: User, generationExpected: number) => {
    let p = await authService.getProfile(u.id);
    if (sessionGenerationManager.getGeneration() !== generationExpected) {
      return null;
    }
    if (!p) {
      p = {
        id: u.id,
        fullName: u.user_metadata?.full_name || u.user_metadata?.name || u.email?.split('@')[0] || 'Пользователь',
        email: u.email || '',
        avatarUrl: u.user_metadata?.avatar_url || '',
        position: 'Специалист',
        department: 'Общий',
        isOnline: true,
      };
    }
    setProfile(p);
    return p;
  }, []);

  // Initialize auth state
  useEffect(() => {
    if (!isSupabaseConfigured) {
      const guestCtx = sessionGenerationManager.getContext();
      syncStorage(guestCtx);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    async function initSession() {
      try {
        const { data } = await supabase.auth.getSession();
        if (!isMounted || isSignedOutRef.current) return;

        // If onAuthStateChange or manual sign-in already fired, don't overwrite with stale getSession result
        if (authEventHandledRef.current) {
          return;
        }

        if (data?.session?.user) {
          const u = data.session.user;
          // Login transition in SessionGenerationManager
          const savedWsId = typeof localStorage !== 'undefined' ? localStorage.getItem('oneteam_active_ws_id') : null;
          const newCtx = sessionGenerationManager.login(u.id, savedWsId);

          setSession(data.session);
          setUser(u);
          isSignedOutRef.current = false;

          await loadUserProfile(u, newCtx.sessionGeneration);
          const activeWs = await loadUserWorkspaces(u.id, newCtx.sessionGeneration);

          // Check again if an auth event took over during async loading
          if (authEventHandledRef.current) return;

          // Update context if active workspace resolved
          const finalizedCtx = activeWs && activeWs.id !== newCtx.workspaceId
            ? sessionGenerationManager.switchWorkspace(activeWs.id)
            : newCtx;

          await syncStorage(finalizedCtx);
        } else {
          // Only perform guest logout if no auth event has occurred and not signed out
          if (!authEventHandledRef.current) {
            setSession(null);
            setUser(null);
            setProfile(null);
            setWorkspaces([]);
            setCurrentWorkspace(null);
            const guestCtx = sessionGenerationManager.logout();
            await syncStorage(guestCtx);
          }
        }
      } catch (err) {
        console.error('[AuthContext] Session init error:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    initSession();

    // Listen to Supabase Auth State Changes
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, currentSession) => {
        if (!isMounted) return;

        authEventHandledRef.current = true;
        const eventTime = Date.now();
        lastEventTimestamp.current = eventTime;

        if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY') {
          if (currentSession?.user) {
            isSignedOutRef.current = false;
            const u = currentSession.user;
            const currentCtx = sessionGenerationManager.getContext();

            // Transition login if user changed or was guest
            const newCtx = sessionGenerationManager.login(u.id, currentCtx.workspaceId);

            setSession(currentSession);
            setUser(u);

            await loadUserProfile(u, newCtx.sessionGeneration);
            const activeWs = await loadUserWorkspaces(u.id, newCtx.sessionGeneration);

            const finalizedCtx = activeWs && activeWs.id !== newCtx.workspaceId
              ? sessionGenerationManager.switchWorkspace(activeWs.id)
              : newCtx;

            await syncStorage(finalizedCtx);
          }
        } else if (event === 'TOKEN_REFRESHED') {
          if (currentSession?.user) {
            // Guard: TOKEN_REFRESHED for the same user and workspace must NOT increment generation
            const currentCtx = sessionGenerationManager.getContext();
            if (
              !currentCtx.isGuest &&
              currentCtx.userId === currentSession.user.id
            ) {
              setSession(currentSession);
              setUser(currentSession.user);
              // Avoid incrementing generation or resetting cache
              return;
            }

            // If user or context differed, perform normal login transition
            const newCtx = sessionGenerationManager.login(currentSession.user.id, currentCtx.workspaceId);
            setSession(currentSession);
            setUser(currentSession.user);
            await syncStorage(newCtx);
          }
        } else if (event === 'SIGNED_OUT') {
          // Idempotent SIGNED_OUT handling
          isSignedOutRef.current = true;
          setSession(null);
          setUser(null);
          setProfile(null);
          setWorkspaces([]);
          setCurrentWorkspace(null);
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('oneteam_active_ws_id');
          }

          const guestCtx = sessionGenerationManager.logout();
          await syncStorage(guestCtx);
        }
        setIsLoading(false);
      }
    );

    return () => {
      isMounted = false;
      authListener?.subscription.unsubscribe();
    };
  }, [loadUserProfile, loadUserWorkspaces, syncStorage]);

  const signUp = async (email: string, pass: string, name: string) => {
    const res = await authService.signUp(email, pass, name);
    if (res.user && !res.session) {
      setNeedsEmailVerification(true);
    }
    return res;
  };

  const signIn = async (email: string, pass: string) => {
    const res = await authService.signIn(email, pass);
    if (res.user) {
      authEventHandledRef.current = true;
      isSignedOutRef.current = false;
      const currentCtx = sessionGenerationManager.getContext();
      const newCtx = sessionGenerationManager.login(res.user.id, currentCtx.workspaceId);

      setUser(res.user);
      setSession(res.session);

      await loadUserProfile(res.user, newCtx.sessionGeneration);
      const activeWs = await loadUserWorkspaces(res.user.id, newCtx.sessionGeneration);

      const finalizedCtx = activeWs && activeWs.id !== newCtx.workspaceId
        ? sessionGenerationManager.switchWorkspace(activeWs.id)
        : newCtx;

      await syncStorage(finalizedCtx);
    }
    return res;
  };

  const signOut = async () => {
    authEventHandledRef.current = true;
    isSignedOutRef.current = true;
    try {
      await authService.signOut();
    } catch (e) {
      console.warn('[AuthContext] Supabase sign out error:', e);
    }

    setUser(null);
    setSession(null);
    setProfile(null);
    setWorkspaces([]);
    setCurrentWorkspace(null);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('oneteam_active_ws_id');
    }

    // Evict Service Worker caches on sign-out to guarantee zero cross-session data leaks
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'LOGOUT_PURGE' });
    }

    const guestCtx = sessionGenerationManager.logout();
    await syncStorage(guestCtx);
  };

  const resetPassword = async (email: string) => {
    return authService.resetPassword(email);
  };

  const updatePassword = async (newPass: string) => {
    return authService.updatePassword(newPass);
  };

  const switchWorkspace = async (workspaceId: string) => {
    const target = workspaces.find((w) => w.id === workspaceId);
    if (target && user) {
      const nextCtx = sessionGenerationManager.switchWorkspace(target.id);
      setCurrentWorkspace(target);

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('oneteam_active_ws_id', target.id);
      }

      await syncStorage(nextCtx);

      const members = await workspaceService.getWorkspaceMembers(target.id);
      if (sessionGenerationManager.getGeneration() === nextCtx.sessionGeneration) {
        const myMember = members.find((m) => m.userId === user.id);
        if (myMember) {
          setCurrentRole(myMember.role);
        }
      }
    }
  };

  const createWorkspace = async (name: string, description = '', avatar = '⚡'): Promise<Workspace> => {
    const ws = await workspaceService.createWorkspace(name, description, avatar);
    if (user) {
      const targetGen = sessionGenerationManager.getGeneration();
      await loadUserWorkspaces(user.id, targetGen);
    }

    const nextCtx = sessionGenerationManager.switchWorkspace(ws.id);
    setCurrentWorkspace(ws);
    setCurrentRole('owner');

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('oneteam_active_ws_id', ws.id);
    }

    await syncStorage(nextCtx);
    return ws;
  };

  const refreshWorkspaces = async () => {
    if (user) {
      await loadUserWorkspaces(user.id, sessionGenerationManager.getGeneration());
    }
  };

  const updateProfile = async (updates: Partial<UserProfile>) => {
    if (!user) return;
    const updated = await authService.updateProfile(user.id, updates);
    if (updated) {
      setProfile(updated);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        workspaces,
        currentWorkspace,
        currentRole,
        isLoading,
        needsEmailVerification,
        setNeedsEmailVerification,
        signUp,
        signIn,
        signOut,
        resetPassword,
        updatePassword,
        switchWorkspace,
        createWorkspace,
        refreshWorkspaces,
        updateProfile,

        // Foundation Fix 01 integrations
        storageContext,
        sessionGeneration,
        isStorageReady,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
