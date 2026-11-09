import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { Modal } from '../common/Modal';
import { Priority, TaskStatus } from '../../types';
import { Eye } from 'lucide-react';

export const TaskModal: React.FC = () => {
  const {
    taskModalOpen,
    taskToEdit,
    closeTaskModal,
    saveTask,
    projects,
    members,
    settings,
  } = useApp();
  const { currentRole } = useAuth();
  const isViewer = currentRole === 'viewer';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState('');

  useEffect(() => {
    if (taskToEdit) {
      setTitle(taskToEdit.title || '');
      setDescription(taskToEdit.description || '');
      setProjectId(taskToEdit.projectId || projects[0]?.id || '');
      setAssigneeId(taskToEdit.assigneeId || members[0]?.id || '');
      setStatus(taskToEdit.status || 'todo');
      setPriority(taskToEdit.priority || 'medium');
      setDueDate(taskToEdit.dueDate || new Date().toISOString().split('T')[0]);
    } else {
      setTitle('');
      setDescription('');
      setProjectId(projects[0]?.id || '');
      setAssigneeId(members[0]?.id || '');
      setStatus('todo');
      setPriority('medium');
      setDueDate(new Date().toISOString().split('T')[0]);
    }
  }, [taskToEdit, taskModalOpen, projects, members]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isViewer) return;
    if (!title.trim()) return;

    saveTask({
      ...(taskToEdit?.id ? { id: taskToEdit.id } : {}),
      title: title.trim(),
      description: description.trim(),
      projectId: projectId || projects[0]?.id || '',
      assigneeId: assigneeId || members[0]?.id || '',
      status,
      priority,
      dueDate: dueDate || new Date().toISOString().split('T')[0],
      completed: status === 'done',
      comments: taskToEdit?.comments || [],
      activities: taskToEdit?.activities || [],
    });

    closeTaskModal();
  };

  return (
    <Modal
      isOpen={taskModalOpen}
      onClose={closeTaskModal}
      title={taskToEdit?.id ? 'Редактировать задачу' : 'Создать новую задачу'}
      subtitle="Заполните параметры задачи и распределите ответственность"
      maxWidth="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {isViewer && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
            <Eye className="w-4 h-4 shrink-0" />
            <span>Режим наблюдателя (Viewer): создание и редактирование задач ограничено.</span>
          </div>
        )}

        {/* Title */}
        <div>
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
            Название задачи *
          </label>
          <input
            type="text"
            required
            disabled={isViewer}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например: Подготовить дизайн-макеты для ревью"
            className="w-full text-sm px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
            Описание
          </label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Подробности задачи, критерии готовности, полезные ссылки..."
            className="w-full text-xs sm:text-sm px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500"
          />
        </div>

        {/* Project & Assignee */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Проект
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full text-xs sm:text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 cursor-pointer"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Исполнитель
            </label>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="w-full text-xs sm:text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 cursor-pointer"
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.position})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Status, Priority, Due Date */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Статус
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="w-full text-xs sm:text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 cursor-pointer"
            >
              <option value="todo">К выполнению</option>
              <option value="in_progress">В работе</option>
              <option value="review">На проверке</option>
              <option value="done">Готово</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Приоритет
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="w-full text-xs sm:text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 cursor-pointer"
            >
              <option value="high">Высокий</option>
              <option value="medium">Средний</option>
              <option value="low">Низкий</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
              Дедлайн
            </label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full text-xs sm:text-sm font-mono px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:border-blue-500 cursor-pointer"
            />
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={closeTaskModal}
            className="px-4 py-2 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            {isViewer ? 'Закрыть' : 'Отмена'}
          </button>
          {!isViewer && (
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-semibold rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {taskToEdit?.id ? 'Сохранить изменения' : 'Создать задачу'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
};
