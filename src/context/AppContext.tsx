import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import {
  PageId,
  Task,
  Project,
  TeamMember,
  WorkspaceSettings,
  NotificationItem,
  TaskStatus,
  ThemeMode,
  Client,
  Transaction,
  Currency,
  ClientNote,
  ClientInteraction,
  TeamMission,
  TeamVision,
  StrategicGoal,
  StrategicPriority,
  DevelopmentPlanItem,
} from '../types';
import { storageServiceAdapter } from '../services/storageAdapter';
import { useAuth } from './AuthContext';
import { cloudDataService } from '../services/cloudDataService';
import { sessionGenerationManager } from '../services/storageContext';

export interface AppContextType {
  // Navigation
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean | ((prev: boolean) => boolean)) => void;

  // Search & Global Filter
  globalSearch: string;
  setGlobalSearch: (q: string) => void;

  // Storage Readiness
  isStorageReady: boolean;

  // Tasks
  tasks: Task[];
  saveTask: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => Task;
  deleteTask: (taskId: string) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  toggleTaskCompletion: (taskId: string) => void;
  addTaskComment: (taskId: string, text: string) => void;

  // Task Drawer & Modal
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  taskModalOpen: boolean;
  taskToEdit: Task | null;
  openCreateTask: (defaultProjectId?: string) => void;
  openEditTask: (task: Task) => void;
  closeTaskModal: () => void;

  // Projects
  projects: Project[];
  saveProject: (project: Omit<Project, 'id' | 'createdAt'> & { id?: string }) => Project;
  deleteProject: (projectId: string) => void;
  toggleArchiveProject: (projectId: string) => void;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  projectModalOpen: boolean;
  projectToEdit: Project | null;
  openCreateProject: () => void;
  openEditProject: (project: Project) => void;
  closeProjectModal: () => void;

  // Members
  members: TeamMember[];
  saveMember: (member: Omit<TeamMember, 'id'> & { id?: string }) => TeamMember;
  deleteMember: (memberId: string) => void;
  selectedMemberId: string | null;
  setSelectedMemberId: (id: string | null) => void;
  inviteModalOpen: boolean;
  setInviteModalOpen: (open: boolean) => void;

  // Clients (Page 8)
  clients: Client[];
  saveClient: (client: Omit<Client, 'id' | 'createdAt'> & { id?: string }) => Client;
  deleteClient: (clientId: string) => void;
  toggleArchiveClient: (clientId: string) => void;
  selectedClientId: string | null;
  setSelectedClientId: (id: string | null) => void;
  clientModalOpen: boolean;
  clientToEdit: Client | null;
  openCreateClient: () => void;
  openEditClient: (client: Client) => void;
  closeClientModal: () => void;
  addClientNote: (clientId: string, text: string) => void;
  addClientInteraction: (clientId: string, interaction: Omit<ClientInteraction, 'id'>) => void;

  // Finance (Page 7)
  transactions: Transaction[];
  saveTransaction: (tx: Omit<Transaction, 'id' | 'createdAt'> & { id?: string }) => Transaction;
  deleteTransaction: (txId: string) => void;
  transactionModalOpen: boolean;
  transactionToEdit: Transaction | null;
  openCreateTransaction: (defaultType?: 'income' | 'expense') => void;
  openEditTransaction: (tx: Transaction) => void;
  closeTransactionModal: () => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;

  // STRATEGY MODULE (Page 4)
  mission: TeamMission;
  saveMission: (mission: TeamMission) => void;
  vision: TeamVision;
  saveVision: (vision: TeamVision) => void;
  goals: StrategicGoal[];
  saveGoal: (goal: Omit<StrategicGoal, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => StrategicGoal;
  deleteGoal: (goalId: string) => void;
  priorities: StrategicPriority[];
  savePriority: (priority: Omit<StrategicPriority, 'id'> & { id?: string }) => StrategicPriority;
  deletePriority: (priorityId: string) => void;
  developmentPlan: DevelopmentPlanItem[];
  savePlanItem: (item: Omit<DevelopmentPlanItem, 'id'> & { id?: string }) => DevelopmentPlanItem;
  deletePlanItem: (itemId: string) => void;

  // Strategy Modals
  goalModalOpen: boolean;
  goalToEdit: StrategicGoal | null;
  openCreateGoal: () => void;
  openEditGoal: (goal: StrategicGoal) => void;
  closeGoalModal: () => void;

  priorityModalOpen: boolean;
  priorityToEdit: StrategicPriority | null;
  openCreatePriority: () => void;
  openEditPriority: (priority: StrategicPriority) => void;
  closePriorityModal: () => void;

  planItemModalOpen: boolean;
  planItemToEdit: DevelopmentPlanItem | null;
  openCreatePlanItem: () => void;
  openEditPlanItem: (item: DevelopmentPlanItem) => void;
  closePlanItemModal: () => void;

  missionModalOpen: boolean;
  setMissionModalOpen: (open: boolean) => void;
  visionModalOpen: boolean;
  setVisionModalOpen: (open: boolean) => void;

  // Settings & Theme
  settings: WorkspaceSettings;
  updateSettings: (newSettings: Partial<WorkspaceSettings>) => void;
  setTheme: (mode: ThemeMode) => void;

  // Notifications
  notifications: NotificationItem[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  deleteNotification: (id: string) => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;

  // Quick Action Modal
  quickCreateOpen: boolean;
  setQuickCreateOpen: (open: boolean) => void;

  // Helper getters
  getProjectById: (id: string) => Project | undefined;
  getMemberById: (id: string) => TeamMember | undefined;
  getClientById: (id: string) => Client | undefined;
  getGoalById: (id: string) => StrategicGoal | undefined;
  refreshData: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { currentWorkspace, user, profile, isStorageReady, storageContext, sessionGeneration } = useAuth();

  const [activePage, setActivePage] = useState<PageId>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 744 && window.innerWidth < 1024;
    }
    return false;
  });

  // Dynamically update sidebar collapse state on orientation change/window resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 744 && window.innerWidth < 1024) {
        setSidebarCollapsed(true);
      } else if (window.innerWidth >= 1024) {
        setSidebarCollapsed(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [globalSearch, setGlobalSearch] = useState('');

  // Domain data - initialized clean; populated when isStorageReady === true
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings>(() => storageServiceAdapter.getSettings());
  const [currency, setCurrency] = useState<Currency>(() => settings.defaultCurrency || 'KZT');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  // Strategy data
  const [mission, setMission] = useState<TeamMission>(() => storageServiceAdapter.getStrategyMission());
  const [vision, setVision] = useState<TeamVision>(() => storageServiceAdapter.getStrategyVision());
  const [goals, setGoals] = useState<StrategicGoal[]>([]);
  const [priorities, setPriorities] = useState<StrategicPriority[]>([]);
  const [developmentPlan, setDevelopmentPlan] = useState<DevelopmentPlanItem[]>([]);

  // Synchronize state when storage becomes ready or context changes
  useEffect(() => {
    // If storage is not ready or user is guest without workspace, isolate and clear state
    if (!isStorageReady || storageContext.isGuest || !currentWorkspace?.id) {
      setTasks([]);
      setProjects([]);
      setClients([]);
      setTransactions([]);
      setGoals([]);
      setPriorities([]);
      setDevelopmentPlan([]);
      setMembers([]);
      setNotifications([]);
      return;
    }

    const currentGen = sessionGeneration;
    const targetWorkspaceId = currentWorkspace.id;

    // Hydrate domain collections from StorageServiceAdapter (100% locally isolated cache)
    setTasks(storageServiceAdapter.getTasks());
    setProjects(storageServiceAdapter.getProjects());
    setClients(storageServiceAdapter.getClients());
    setTransactions(storageServiceAdapter.getTransactions());
    setGoals(storageServiceAdapter.getStrategicGoals());
    setPriorities(storageServiceAdapter.getStrategicPriorities());
    setDevelopmentPlan(storageServiceAdapter.getDevelopmentPlan());
    setMembers(storageServiceAdapter.getMembers());
    setNotifications(storageServiceAdapter.getNotifications());
    setMission(storageServiceAdapter.getStrategyMission());
    setVision(storageServiceAdapter.getStrategyVision());

    const latestSettings = storageServiceAdapter.getSettings();
    setSettings({
      ...latestSettings,
      workspaceName: currentWorkspace.name,
      workspaceDescription: currentWorkspace.description,
      workspaceAvatar: currentWorkspace.avatar,
      currentUser: profile
        ? {
            id: profile.id,
            name: profile.fullName,
            email: profile.email,
            position: profile.position || 'Специалист',
            role: 'owner',
            avatar: profile.avatarUrl || '',
          }
        : latestSettings.currentUser,
    });

    let isCancelled = false;

    // Asynchronously fetch cloud data with race condition protection
    cloudDataService.loadWorkspaceData(targetWorkspaceId).then((data) => {
      // Guard against race conditions: abort if context changed or session generation advanced
      if (isCancelled || sessionGenerationManager.getGeneration() !== currentGen) {
        return;
      }
      if (data) {
        if (data.tasks) setTasks(data.tasks);
        if (data.projects) setProjects(data.projects);
        if (data.clients) setClients(data.clients);
        if (data.transactions) setTransactions(data.transactions);
        if (data.goals) setGoals(data.goals);
        if (data.priorities) setPriorities(data.priorities);
        if (data.plans) setDevelopmentPlan(data.plans);
        if (data.mission) setMission(data.mission);
        if (data.vision) setVision(data.vision);
        if (data.members) setMembers(data.members);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [isStorageReady, currentWorkspace?.id, profile, sessionGeneration, storageContext.isGuest]);

  // Modals & Panels
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectToEdit, setProjectToEdit] = useState<Project | null>(null);

  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);

  // Client modals & panels
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [clientToEdit, setClientToEdit] = useState<Client | null>(null);

  // Finance modals
  const [transactionModalOpen, setTransactionModalOpen] = useState(false);
  const [transactionToEdit, setTransactionToEdit] = useState<Transaction | null>(null);

  // Strategy modals
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [goalToEdit, setGoalToEdit] = useState<StrategicGoal | null>(null);

  const [priorityModalOpen, setPriorityModalOpen] = useState(false);
  const [priorityToEdit, setPriorityToEdit] = useState<StrategicPriority | null>(null);

  const [planItemModalOpen, setPlanItemModalOpen] = useState(false);
  const [planItemToEdit, setPlanItemToEdit] = useState<DevelopmentPlanItem | null>(null);

  const [missionModalOpen, setMissionModalOpen] = useState(false);
  const [visionModalOpen, setVisionModalOpen] = useState(false);

  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  // Hydrate projects with dynamic task counts, progress, and clientName
  const enrichedProjects = projects.map((proj) => {
    const projTasks = tasks.filter((t) => t.projectId === proj.id);
    const total = projTasks.length;
    const completed = projTasks.filter((t) => t.completed || t.status === 'done').length;
    const computedProgress = total > 0 ? Math.round((completed / total) * 100) : proj.progress;
    const client = clients.find((c) => c.id === proj.clientId);

    return {
      ...proj,
      totalTasks: total,
      completedTasks: completed,
      progress: computedProgress,
      clientName: client?.name || proj.clientName,
    };
  });

  // Hydrate tasks with project and assignee names
  const enrichedTasks = tasks.map((t) => {
    const proj = projects.find((p) => p.id === t.projectId);
    const assignee = members.find((m) => m.id === t.assigneeId);
    return {
      ...t,
      projectName: proj?.name || 'Без проекта',
      assigneeName: assignee?.name || 'Не назначен',
      assigneeAvatar: assignee?.avatar,
    };
  });

  // Hydrate clients with associated project name
  const enrichedClients = clients.map((c) => {
    const proj = projects.find((p) => p.id === c.associatedProjectId);
    return {
      ...c,
      associatedProjectName: proj?.name,
    };
  });

  // Hydrate transactions with project and client names
  const enrichedTransactions = transactions.map((tx) => {
    const proj = projects.find((p) => p.id === tx.projectId);
    const client = clients.find((c) => c.id === tx.clientId);
    return {
      ...tx,
      projectName: proj?.name,
      clientName: client?.name,
    };
  });

  // Hydrate goals with owner name
  const enrichedGoals = goals.map((g) => {
    const owner = members.find((m) => m.id === g.ownerId);
    return {
      ...g,
      ownerName: owner?.name || g.ownerName || 'Руководитель',
    };
  });

  // Hydrate priorities with owner name and related goal title
  const enrichedPriorities = priorities.map((p) => {
    const owner = members.find((m) => m.id === p.ownerId);
    const goal = goals.find((g) => g.id === p.relatedGoalId);
    return {
      ...p,
      ownerName: owner?.name || p.ownerName,
      relatedGoalTitle: goal?.title || p.relatedGoalTitle,
    };
  });

  // Hydrate development plan with owner name and related goal title
  const enrichedPlan = developmentPlan.map((item) => {
    const owner = members.find((m) => m.id === item.ownerId);
    const goal = goals.find((g) => g.id === item.relatedGoalId);
    return {
      ...item,
      ownerName: owner?.name || item.ownerName,
      relatedGoalTitle: goal?.title || item.relatedGoalTitle,
    };
  });

  // Synchronize Theme
  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      if (isDark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };

    applyTheme();

    if (settings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => applyTheme();
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [settings.theme]);

  const refreshData = () => {
    if (!isStorageReady) return;
    setTasks(storageServiceAdapter.getTasks());
    setProjects(storageServiceAdapter.getProjects());
    setMembers(storageServiceAdapter.getMembers());
    setClients(storageServiceAdapter.getClients());
    setTransactions(storageServiceAdapter.getTransactions());
    setSettings(storageServiceAdapter.getSettings());
    setNotifications(storageServiceAdapter.getNotifications());
  };

  // Task Actions
  const saveTask = (taskData: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => {
    const saved = storageServiceAdapter.saveTask(taskData);
    setTasks(storageServiceAdapter.getTasks());
    if (currentWorkspace?.id) {
      cloudDataService.syncTask(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deleteTask = (taskId: string) => {
    storageServiceAdapter.deleteTask(taskId);
    setTasks(storageServiceAdapter.getTasks());
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null);
    }
    if (currentWorkspace?.id) {
      cloudDataService.deleteTask(currentWorkspace.id, taskId);
    }
  };

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    const updated = storageServiceAdapter.updateTaskStatus(taskId, status);
    setTasks(storageServiceAdapter.getTasks());
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncTask(currentWorkspace.id, updated);
    }
  };

  const toggleTaskCompletion = (taskId: string) => {
    const updated = storageServiceAdapter.toggleTaskCompletion(taskId);
    setTasks(storageServiceAdapter.getTasks());
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncTask(currentWorkspace.id, updated);
    }
  };

  const addTaskComment = (taskId: string, text: string) => {
    if (!text.trim()) return;
    storageServiceAdapter.addTaskComment(taskId, text, {
      name: settings.currentUser.name,
      avatar: settings.currentUser.avatar,
    });
    const latestTasks = storageServiceAdapter.getTasks();
    setTasks(latestTasks);
    const updated = latestTasks.find((t) => t.id === taskId);
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncTask(currentWorkspace.id, updated);
    }
  };

  const openCreateTask = (defaultProjectId?: string) => {
    setTaskToEdit(
      defaultProjectId
        ? ({
            id: '',
            title: '',
            description: '',
            status: 'todo',
            priority: 'medium',
            projectId: defaultProjectId,
            assigneeId: members[0]?.id || '',
            dueDate: new Date().toISOString().split('T')[0],
            completed: false,
            comments: [],
            activities: [],
            createdAt: '',
            updatedAt: '',
          } as Task)
        : null
    );
    setTaskModalOpen(true);
  };

  const openEditTask = (task: Task) => {
    setTaskToEdit(task);
    setTaskModalOpen(true);
  };

  const closeTaskModal = () => {
    setTaskModalOpen(false);
    setTaskToEdit(null);
  };

  // Project Actions
  const saveProject = (projData: Omit<Project, 'id' | 'createdAt'> & { id?: string }) => {
    const saved = storageServiceAdapter.saveProject(projData);
    setProjects(storageServiceAdapter.getProjects());
    if (currentWorkspace?.id) {
      cloudDataService.syncProject(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deleteProject = (projectId: string) => {
    storageServiceAdapter.deleteProject(projectId);
    setProjects(storageServiceAdapter.getProjects());
    if (selectedProjectId === projectId) {
      setSelectedProjectId(null);
    }
    if (currentWorkspace?.id) {
      cloudDataService.deleteProject(currentWorkspace.id, projectId);
    }
  };

  const toggleArchiveProject = (projectId: string) => {
    const updated = storageServiceAdapter.toggleArchiveProject(projectId);
    setProjects(storageServiceAdapter.getProjects());
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncProject(currentWorkspace.id, updated);
    }
  };

  const openCreateProject = () => {
    setProjectToEdit(null);
    setProjectModalOpen(true);
  };

  const openEditProject = (project: Project) => {
    setProjectToEdit(project);
    setProjectModalOpen(true);
  };

  const closeProjectModal = () => {
    setProjectModalOpen(false);
    setProjectToEdit(null);
  };

  // Member Actions
  const saveMember = (memberData: Omit<TeamMember, 'id'> & { id?: string }) => {
    const saved = storageServiceAdapter.saveMember(memberData);
    setMembers(storageServiceAdapter.getMembers());
    return saved;
  };

  const deleteMember = (memberId: string) => {
    storageServiceAdapter.deleteMember(memberId);
    setMembers(storageServiceAdapter.getMembers());
    if (selectedMemberId === memberId) {
      setSelectedMemberId(null);
    }
  };

  // Client Actions
  const saveClient = (clientData: Omit<Client, 'id' | 'createdAt'> & { id?: string }) => {
    const saved = storageServiceAdapter.saveClient(clientData);
    setClients(storageServiceAdapter.getClients());
    if (currentWorkspace?.id) {
      cloudDataService.syncClient(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deleteClient = (clientId: string) => {
    storageServiceAdapter.deleteClient(clientId);
    setClients(storageServiceAdapter.getClients());
    if (selectedClientId === clientId) {
      setSelectedClientId(null);
    }
    if (currentWorkspace?.id) {
      cloudDataService.deleteClient(currentWorkspace.id, clientId);
    }
  };

  const toggleArchiveClient = (clientId: string) => {
    const updated = storageServiceAdapter.toggleArchiveClient(clientId);
    setClients(storageServiceAdapter.getClients());
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncClient(currentWorkspace.id, updated);
    }
  };

  const openCreateClient = () => {
    setClientToEdit(null);
    setClientModalOpen(true);
  };

  const openEditClient = (client: Client) => {
    setClientToEdit(client);
    setClientModalOpen(true);
  };

  const closeClientModal = () => {
    setClientModalOpen(false);
    setClientToEdit(null);
  };

  const addClientNote = (clientId: string, text: string) => {
    storageServiceAdapter.addClientNote(clientId, text, settings.currentUser.name);
    const latestClients = storageServiceAdapter.getClients();
    setClients(latestClients);
    const updated = latestClients.find((c) => c.id === clientId);
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncClient(currentWorkspace.id, updated);
    }
  };

  const addClientInteraction = (
    clientId: string,
    interaction: Omit<ClientInteraction, 'id'>
  ) => {
    storageServiceAdapter.addClientInteraction(clientId, interaction);
    const latestClients = storageServiceAdapter.getClients();
    setClients(latestClients);
    const updated = latestClients.find((c) => c.id === clientId);
    if (updated && currentWorkspace?.id) {
      cloudDataService.syncClient(currentWorkspace.id, updated);
    }
  };

  // Finance Actions
  const saveTransaction = (txData: Omit<Transaction, 'id' | 'createdAt'> & { id?: string }) => {
    const saved = storageServiceAdapter.saveTransaction(txData);
    setTransactions(storageServiceAdapter.getTransactions());
    if (currentWorkspace?.id) {
      cloudDataService.syncTransaction(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deleteTransaction = (txId: string) => {
    storageServiceAdapter.deleteTransaction(txId);
    setTransactions(storageServiceAdapter.getTransactions());
    if (currentWorkspace?.id) {
      cloudDataService.deleteTransaction(currentWorkspace.id, txId);
    }
  };

  const openCreateTransaction = (defaultType?: 'income' | 'expense') => {
    setTransactionToEdit(
      defaultType
        ? ({
            id: '',
            title: '',
            amount: 0,
            currency: currency,
            type: defaultType,
            category: defaultType === 'income' ? 'client_payment' : 'operations',
            date: new Date().toISOString().split('T')[0],
            status: 'completed',
            createdAt: '',
          } as Transaction)
        : null
    );
    setTransactionModalOpen(true);
  };

  const openEditTransaction = (tx: Transaction) => {
    setTransactionToEdit(tx);
    setTransactionModalOpen(true);
  };

  const closeTransactionModal = () => {
    setTransactionModalOpen(false);
    setTransactionToEdit(null);
  };

  // Strategy Actions
  const saveMission = (newMission: TeamMission) => {
    const saved = storageServiceAdapter.saveStrategyMission(newMission);
    setMission(saved);
    if (currentWorkspace?.id) {
      cloudDataService.syncMission(currentWorkspace.id, saved);
    }
  };

  const saveVision = (newVision: TeamVision) => {
    const saved = storageServiceAdapter.saveStrategyVision(newVision);
    setVision(saved);
    if (currentWorkspace?.id) {
      cloudDataService.syncVision(currentWorkspace.id, saved);
    }
  };

  const saveGoal = (
    goalData: Omit<StrategicGoal, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ) => {
    const saved = storageServiceAdapter.saveStrategicGoal(goalData);
    setGoals(storageServiceAdapter.getStrategicGoals());
    if (currentWorkspace?.id) {
      cloudDataService.syncGoal(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deleteGoal = (goalId: string) => {
    storageServiceAdapter.deleteStrategicGoal(goalId);
    setGoals(storageServiceAdapter.getStrategicGoals());
    if (currentWorkspace?.id) {
      cloudDataService.deleteGoal(currentWorkspace.id, goalId);
    }
  };

  const openCreateGoal = () => {
    setGoalToEdit(null);
    setGoalModalOpen(true);
  };

  const openEditGoal = (goal: StrategicGoal) => {
    setGoalToEdit(goal);
    setGoalModalOpen(true);
  };

  const closeGoalModal = () => {
    setGoalModalOpen(false);
    setGoalToEdit(null);
  };

  const savePriority = (
    priorityData: Omit<StrategicPriority, 'id'> & { id?: string }
  ) => {
    const saved = storageServiceAdapter.saveStrategicPriority(priorityData);
    setPriorities(storageServiceAdapter.getStrategicPriorities());
    if (currentWorkspace?.id) {
      cloudDataService.syncPriority(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deletePriority = (priorityId: string) => {
    storageServiceAdapter.deleteStrategicPriority(priorityId);
    setPriorities(storageServiceAdapter.getStrategicPriorities());
    if (currentWorkspace?.id) {
      cloudDataService.deletePriority(currentWorkspace.id, priorityId);
    }
  };

  const openCreatePriority = () => {
    setPriorityToEdit(null);
    setPriorityModalOpen(true);
  };

  const openEditPriority = (priority: StrategicPriority) => {
    setPriorityToEdit(priority);
    setPriorityModalOpen(true);
  };

  const closePriorityModal = () => {
    setPriorityModalOpen(false);
    setPriorityToEdit(null);
  };

  const savePlanItem = (
    itemData: Omit<DevelopmentPlanItem, 'id'> & { id?: string }
  ) => {
    const saved = storageServiceAdapter.saveDevelopmentPlanItem(itemData);
    setDevelopmentPlan(storageServiceAdapter.getDevelopmentPlan());
    if (currentWorkspace?.id) {
      cloudDataService.syncPlanItem(currentWorkspace.id, saved);
    }
    return saved;
  };

  const deletePlanItem = (itemId: string) => {
    storageServiceAdapter.deleteDevelopmentPlanItem(itemId);
    setDevelopmentPlan(storageServiceAdapter.getDevelopmentPlan());
    if (currentWorkspace?.id) {
      cloudDataService.deletePlanItem(currentWorkspace.id, itemId);
    }
  };

  const openCreatePlanItem = () => {
    setPlanItemToEdit(null);
    setPlanItemModalOpen(true);
  };

  const openEditPlanItem = (item: DevelopmentPlanItem) => {
    setPlanItemToEdit(item);
    setPlanItemModalOpen(true);
  };

  const closePlanItemModal = () => {
    setPlanItemModalOpen(false);
    setPlanItemToEdit(null);
  };

  // Settings & Theme
  const updateSettings = (newSettings: Partial<WorkspaceSettings>) => {
    const updated = storageServiceAdapter.updateSettings(newSettings);
    setSettings(updated);
    if (currentWorkspace?.id) {
      cloudDataService.syncSettings(currentWorkspace.id, updated);
    }
  };

  const setTheme = (mode: ThemeMode) => {
    updateSettings({ theme: mode });
  };

  // Notifications
  const markNotificationRead = (id: string) => {
    storageServiceAdapter.markNotificationRead(id);
    setNotifications(storageServiceAdapter.getNotifications());
  };

  const markAllNotificationsRead = () => {
    storageServiceAdapter.markAllNotificationsRead();
    setNotifications(storageServiceAdapter.getNotifications());
  };

  const deleteNotification = (id: string) => {
    storageServiceAdapter.deleteNotification(id);
    setNotifications(storageServiceAdapter.getNotifications());
  };

  const getProjectById = (id: string) => enrichedProjects.find((p) => p.id === id);
  const getMemberById = (id: string) => members.find((m) => m.id === id);
  const getClientById = (id: string) => enrichedClients.find((c) => c.id === id);
  const getGoalById = (id: string) => enrichedGoals.find((g) => g.id === id);

  return (
    <AppContext.Provider
      value={{
        activePage,
        setActivePage,
        sidebarCollapsed,
        setSidebarCollapsed,
        globalSearch,
        setGlobalSearch,
        isStorageReady,
        tasks: enrichedTasks,
        saveTask,
        deleteTask,
        updateTaskStatus,
        toggleTaskCompletion,
        addTaskComment,
        selectedTaskId,
        setSelectedTaskId,
        taskModalOpen,
        taskToEdit,
        openCreateTask,
        openEditTask,
        closeTaskModal,
        projects: enrichedProjects,
        saveProject,
        deleteProject,
        toggleArchiveProject,
        selectedProjectId,
        setSelectedProjectId,
        projectModalOpen,
        projectToEdit,
        openCreateProject,
        openEditProject,
        closeProjectModal,
        members,
        saveMember,
        deleteMember,
        selectedMemberId,
        setSelectedMemberId,
        inviteModalOpen,
        setInviteModalOpen,
        clients: enrichedClients,
        saveClient,
        deleteClient,
        toggleArchiveClient,
        selectedClientId,
        setSelectedClientId,
        clientModalOpen,
        clientToEdit,
        openCreateClient,
        openEditClient,
        closeClientModal,
        addClientNote,
        addClientInteraction,
        transactions: enrichedTransactions,
        saveTransaction,
        deleteTransaction,
        transactionModalOpen,
        transactionToEdit,
        openCreateTransaction,
        openEditTransaction,
        closeTransactionModal,
        currency,
        setCurrency,
        mission,
        saveMission,
        vision,
        saveVision,
        goals: enrichedGoals,
        saveGoal,
        deleteGoal,
        priorities: enrichedPriorities,
        savePriority,
        deletePriority,
        developmentPlan: enrichedPlan,
        savePlanItem,
        deletePlanItem,
        goalModalOpen,
        goalToEdit,
        openCreateGoal,
        openEditGoal,
        closeGoalModal,
        priorityModalOpen,
        priorityToEdit,
        openCreatePriority,
        openEditPriority,
        closePriorityModal,
        planItemModalOpen,
        planItemToEdit,
        openCreatePlanItem,
        openEditPlanItem,
        closePlanItemModal,
        missionModalOpen,
        setMissionModalOpen,
        visionModalOpen,
        setVisionModalOpen,
        settings,
        updateSettings,
        setTheme,
        notifications,
        markNotificationRead,
        markAllNotificationsRead,
        deleteNotification,
        notificationsOpen,
        setNotificationsOpen,
        quickCreateOpen,
        setQuickCreateOpen,
        getProjectById,
        getMemberById,
        getClientById,
        getGoalById,
        refreshData,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
