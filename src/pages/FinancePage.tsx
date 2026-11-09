import React, { useState, useMemo } from 'react';
import {
  Wallet,
  ArrowUpRight,
  ArrowDownLeft,
  Plus,
  Download,
  Search,
  Filter,
  DollarSign,
  TrendingUp,
  CreditCard,
  Building2,
  Trash2,
  Edit,
  FolderGit2,
  PieChart,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Currency, FinancialCategory, Transaction, TransactionType } from '../types';
import { TransactionModal } from '../components/finance/TransactionModal';
import { ProgressBar } from '../components/common/ProgressBar';

export const FinancePage: React.FC = () => {
  const {
    transactions,
    deleteTransaction,
    openCreateTransaction,
    openEditTransaction,
    currency,
    setCurrency,
    projects,
    setSelectedProjectId,
    setActivePage,
  } = useApp();

  const [periodFilter, setPeriodFilter] = useState<'october' | 'november' | 'all'>('october');
  const [typeFilter, setTypeFilter] = useState<'all' | TransactionType>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // Fixed demo exchange rates to convert consistently if user switches currency
  const ratesToKZT: Record<Currency, number> = {
    KZT: 1,
    USD: 490,
    RUB: 5.2,
  };

  const currencySymbols: Record<Currency, string> = {
    KZT: '₸',
    USD: '$',
    RUB: '₽',
  };

  const formatMoney = (amountInKZT: number): string => {
    const rate = ratesToKZT[currency];
    const converted = amountInKZT / rate;
    const formatted = Math.round(converted).toLocaleString('ru-RU');
    return `${formatted} ${currencySymbols[currency]}`;
  };

  // Category labels and colors
  const categoryLabels: Record<FinancialCategory, { label: string; colorClass: string }> = {
    salaries: { label: 'ФОТ и зарплаты', colorClass: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/40' },
    software: { label: 'ПО и сервисы', colorClass: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40' },
    marketing: { label: 'Маркетинг и реклама', colorClass: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40' },
    infrastructure: { label: 'Инфраструктура', colorClass: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40' },
    operations: { label: 'Операционные расходы', colorClass: 'text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800' },
    client_payment: { label: 'Оплата от клиента', colorClass: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40' },
    other: { label: 'Прочее', colorClass: 'text-slate-500 bg-slate-100 dark:bg-slate-800' },
  };

  // Filter transactions
  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      // Period filter
      if (periodFilter === 'october') {
        if (!tx.date.startsWith('2026-10')) return false;
      } else if (periodFilter === 'november') {
        if (!tx.date.startsWith('2026-11')) return false;
      }

      // Type filter
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false;

      // Category filter
      if (categoryFilter !== 'all' && tx.category !== categoryFilter) return false;

      // Search term
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const matchesTitle = tx.title.toLowerCase().includes(q);
        const matchesNotes = tx.notes?.toLowerCase().includes(q);
        const matchesProj = tx.projectName?.toLowerCase().includes(q);
        const matchesClient = tx.clientName?.toLowerCase().includes(q);
        if (!matchesTitle && !matchesNotes && !matchesProj && !matchesClient) return false;
      }

      return true;
    });
  }, [transactions, periodFilter, typeFilter, categoryFilter, searchTerm]);

  // Segregated multi-currency sums (prevents blending different currencies without rate validation)
  const currencyTotals = useMemo(() => {
    const totals: Record<Currency, { income: number; expense: number; balance: number }> = {
      KZT: { income: 0, expense: 0, balance: 0 },
      USD: { income: 0, expense: 0, balance: 0 },
      RUB: { income: 0, expense: 0, balance: 0 },
    };

    filteredTransactions.forEach((tx) => {
      const cur = (tx.currency as Currency) || 'KZT';
      if (!totals[cur]) {
        totals[cur] = { income: 0, expense: 0, balance: 0 };
      }
      if (tx.type === 'income') {
        totals[cur].income += tx.amount;
        totals[cur].balance += tx.amount;
      } else {
        totals[cur].expense += tx.amount;
        totals[cur].balance -= tx.amount;
      }
    });

    return totals;
  }, [filteredTransactions]);

  // Aggregate totals (in KZT base, converted via formatMoney)
  const totalIncome = filteredTransactions
    .filter((tx) => tx.type === 'income')
    .reduce((acc, tx) => acc + tx.amount, 0);

  const totalExpenses = filteredTransactions
    .filter((tx) => tx.type === 'expense')
    .reduce((acc, tx) => acc + tx.amount, 0);

  const netProfit = totalIncome - totalExpenses;
  const currentBalance = totalIncome - totalExpenses;

  // Expense categories breakdown
  const expenseCategoriesBreakdown = useMemo(() => {
    const expenses = filteredTransactions.filter((tx) => tx.type === 'expense');
    const totalExp = expenses.reduce((acc, tx) => acc + tx.amount, 0);

    const map: Record<string, number> = {};
    expenses.forEach((tx) => {
      map[tx.category] = (map[tx.category] || 0) + tx.amount;
    });

    return Object.entries(map).map(([cat, amount]) => ({
      category: cat as FinancialCategory,
      amount,
      percentage: totalExp > 0 ? Math.round((amount / totalExp) * 100) : 0,
    }));
  }, [filteredTransactions]);

  // Monthly dynamics calculated strictly from actual transactions grouped by month
  const monthlyDynamics = useMemo(() => {
    const monthsMap: Record<string, { income: number; expense: number }> = {};
    transactions.forEach((tx) => {
      const monthKey = tx.date.substring(0, 7); // e.g. "2026-10"
      if (!monthsMap[monthKey]) {
        monthsMap[monthKey] = { income: 0, expense: 0 };
      }
      if (tx.type === 'income') {
        monthsMap[monthKey].income += tx.amount;
      } else {
        monthsMap[monthKey].expense += tx.amount;
      }
    });

    const sortedMonths = Object.keys(monthsMap).sort();
    return sortedMonths.map((mKey) => {
      const [year, monthNum] = mKey.split('-');
      const monthNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
      const mName = monthNames[parseInt(monthNum, 10) - 1] || mKey;
      return {
        month: `${mName} '${year.slice(2)}`,
        income: monthsMap[mKey].income,
        expense: monthsMap[mKey].expense,
      };
    });
  }, [transactions]);

  // CSV Export handler with currency breakdown
  const handleExportCSV = () => {
    const rows = [
      ['Название', 'Тип', 'Категория', 'Сумма', 'Валюта', 'Дата', 'Проект', 'Клиент', 'Статус'],
      ...filteredTransactions.map((tx) => [
        tx.title,
        tx.type === 'income' ? 'Доход' : 'Расход',
        categoryLabels[tx.category]?.label || tx.category,
        tx.amount.toString(),
        tx.currency || 'KZT',
        tx.date,
        tx.projectName || '',
        tx.clientName || '',
        tx.status,
      ]),
      [],
      ['--- ИТОГИ ПО ВАЛЮТАМ ---'],
      ['Валюта', 'Доходы', 'Расходы', 'Остаток'],
      ['KZT', currencyTotals.KZT.income.toString(), currencyTotals.KZT.expense.toString(), currencyTotals.KZT.balance.toString()],
      ['USD', currencyTotals.USD.income.toString(), currencyTotals.USD.expense.toString(), currencyTotals.USD.balance.toString()],
      ['RUB', currencyTotals.RUB.income.toString(), currencyTotals.RUB.expense.toString(), currencyTotals.RUB.balance.toString()],
    ];

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' +
      rows.map((e) => e.map((cell) => `"${cell}"`).join(',')).join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `oneteam_finance_${periodFilter}_2026.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              Финансы
            </h1>
            <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono">
              Октябрь – Ноябрь 2026
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            Контроль денежных потоков, структуры расходов и чистой прибыли проектов
          </p>
        </div>

        {/* Currency Switcher & Add Transaction */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Currency Selector */}
          <div className="flex items-center p-1 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200/60 dark:border-slate-700/60">
            {(['KZT', 'USD', 'RUB'] as Currency[]).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  currency === c
                    ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                {c} ({currencySymbols[c]})
              </button>
            ))}
          </div>

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Экспорт</span>
          </button>

          <button
            onClick={() => openCreateTransaction()}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs sm:text-sm font-semibold shadow-xs shadow-blue-600/30 transition-all active:scale-95 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Новая операция</span>
          </button>
        </div>
      </div>

      {/* Currency conversion notice if USD or RUB */}
      {currency !== 'KZT' && (
        <div className="text-xs text-slate-500 bg-blue-50 dark:bg-blue-950/20 border border-blue-200/60 dark:border-blue-900/40 px-3.5 py-2 rounded-xl flex items-center justify-between">
          <span>
            Демо-пересчёт по фиксированному курсу: 1 {currency} = {ratesToKZT[currency]} ₸
          </span>
          <span className="font-mono text-slate-400">Базовая валюта: KZT</span>
        </div>
      )}

      {/* TOP 4 KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Общий доход */}
        <div className="p-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Выручка / Доход
            </span>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {formatMoney(totalIncome)}
            </div>
            <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-md font-mono">
              +12%
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-1">3 входящих платежа</div>
        </div>

        {/* 2. Общие расходы */}
        <div className="p-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Расходы команды
            </span>
            <div className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center justify-center">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {formatMoney(totalExpenses)}
            </div>
            <span className="text-[11px] font-medium text-rose-600 bg-rose-50 dark:bg-rose-950/40 px-2 py-0.5 rounded-md font-mono">
              +8%
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-1">ФОТ, софт, реклама</div>
        </div>

        {/* 3. Чистая прибыль */}
        <div className="p-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Чистая прибыль
            </span>
            <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {formatMoney(netProfit)}
            </div>
            <span className="text-[11px] font-medium text-blue-600 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded-md font-mono">
              +20%
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-1">Рентабельность: 39.6%</div>
        </div>

        {/* 4. Текущий баланс */}
        <div className="p-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Текущий остаток
            </span>
            <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between mt-1">
            <div className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
              {formatMoney(currentBalance)}
            </div>
            <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-md font-mono">
              Активен
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-1">Расчётный счёт компании</div>
        </div>
      </div>

      {/* Segregated Multi-Currency Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(['KZT', 'USD', 'RUB'] as Currency[]).map((cur) => {
          const tot = currencyTotals[cur];
          return (
            <div
              key={cur}
              className="p-3 bg-white dark:bg-slate-900/60 rounded-xl border border-slate-200/60 dark:border-slate-800/80 text-xs flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-bold flex items-center justify-center text-[11px]">
                  {currencySymbols[cur]}
                </span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">{cur}</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-emerald-600 dark:text-emerald-400">+{tot.income.toLocaleString('ru-RU')}</span>
                <span className="text-rose-600 dark:text-rose-400">−{tot.expense.toLocaleString('ru-RU')}</span>
                <span className="font-bold text-slate-900 dark:text-white">= {tot.balance.toLocaleString('ru-RU')}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* SECTION A & B: Dynamics Chart + Expense Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* A. Financial overview chart */}
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-5 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-slate-800 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Динамика финансов
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Ежемесячное соотношение выручки и операционных расходов
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-blue-600" />
                  <span className="text-slate-600 dark:text-slate-400 font-medium">Выручка</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-purple-500" />
                  <span className="text-slate-600 dark:text-slate-400 font-medium">Расходы</span>
                </div>
              </div>
            </div>

            {/* Monthly Dynamics Chart Visual */}
            {monthlyDynamics.length === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center text-center text-slate-400 text-xs">
                <TrendingUp className="w-8 h-8 text-slate-300 dark:text-slate-700 mb-2" />
                <p className="font-medium text-slate-600 dark:text-slate-300">Данные динамики отсутствуют</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Добавьте доходы и расходы для построения динамики</p>
              </div>
            ) : (
              <div className="pt-4 pb-2">
                <div className="h-56 flex items-end justify-between gap-3 px-2">
                  {monthlyDynamics.map((item, idx) => {
                    const maxVal = Math.max(...monthlyDynamics.map((m) => Math.max(m.income, m.expense)), 1);
                    const incHeight = Math.round((item.income / maxVal) * 100);
                    const expHeight = Math.round((item.expense / maxVal) * 100);

                    return (
                      <div key={idx} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                        <div className="w-full flex items-end justify-center gap-1.5 h-full">
                          {/* Expense bar */}
                          <div
                            className="w-1/2 max-w-[20px] bg-purple-400/80 dark:bg-purple-900/60 rounded-t-md transition-all duration-300 hover:bg-purple-500"
                            style={{ height: `${expHeight}%` }}
                            title={`Расходы: ${formatMoney(item.expense)}`}
                          />
                          {/* Income bar */}
                          <div
                            className="w-1/2 max-w-[20px] bg-blue-600 hover:bg-blue-700 rounded-t-md transition-all duration-300"
                            style={{ height: `${incHeight}%` }}
                            title={`Выручка: ${formatMoney(item.income)}`}
                          />
                        </div>
                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 font-mono">
                          {item.month}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
            <span>Локальный учёт финансов</span>
            <span className="font-mono text-slate-600 dark:text-slate-300">{transactions.length} операций</span>
          </div>
        </div>

        {/* B. Expense breakdown (Категории) */}
        <div className="lg:col-span-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-5 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 dark:border-slate-800 mb-4">
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <PieChart className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                Структура расходов
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                {expenseCategoriesBreakdown.length} категорий
              </span>
            </div>

            <div className="space-y-3.5">
              {expenseCategoriesBreakdown.map((item) => {
                const conf = categoryLabels[item.category] || categoryLabels.other;
                return (
                  <div key={item.category} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800 dark:text-slate-200">
                        {conf.label}
                      </span>
                      <div className="flex items-center gap-2 font-mono">
                        <span className="text-slate-500">{formatMoney(item.amount)}</span>
                        <span className="font-bold text-slate-900 dark:text-white w-9 text-right">
                          {item.percentage}%
                        </span>
                      </div>
                    </div>
                    <ProgressBar
                      progress={item.percentage}
                      color={item.percentage >= 40 ? 'purple' : item.percentage >= 15 ? 'blue' : 'amber'}
                      height="sm"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
            <span>Основная статья расходов: ФОТ</span>
            <span className="font-mono text-slate-600 dark:text-slate-300">55% бюджета</span>
          </div>
        </div>
      </div>

      {/* SECTION C: Transactions Table with Filters & Search */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs overflow-hidden">
        {/* Table Filters Toolbar */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-slate-500 font-semibold px-1">
              <Filter className="w-3.5 h-3.5" />
              <span>Фильтр:</span>
            </div>

            {/* Period filter */}
            <select
              value={periodFilter}
              onChange={(e) => setPeriodFilter(e.target.value as any)}
              className="py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-hidden cursor-pointer min-h-[38px]"
            >
              <option value="october">Октябрь 2026</option>
              <option value="november">Ноябрь 2026</option>
              <option value="all">Все периоды</option>
            </select>

            {/* Type filter */}
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as any)}
              className="py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-hidden cursor-pointer min-h-[38px]"
            >
              <option value="all">Все типы операций</option>
              <option value="income">Только доходы (+)</option>
              <option value="expense">Только расходы (−)</option>
            </select>

            {/* Category filter */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium focus:outline-hidden cursor-pointer min-h-[38px]"
            >
              <option value="all">Все категории</option>
              <option value="client_payment">Оплата от клиента</option>
              <option value="salaries">ФОТ и зарплаты</option>
              <option value="software">ПО и подписки</option>
              <option value="marketing">Маркетинг и реклама</option>
              <option value="infrastructure">Инфраструктура</option>
              <option value="operations">Операционные</option>
            </select>
          </div>

          {/* Search input */}
          <div className="relative w-full lg:w-64 shrink-0">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Поиск по платежам..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-hidden focus:border-blue-500"
            />
          </div>
        </div>

        {/* Transactions Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <th className="py-3 px-4">Операция</th>
                <th className="py-3 px-4">Категория</th>
                <th className="py-3 px-4">Дата</th>
                <th className="py-3 px-4">Проект / Клиент</th>
                <th className="py-3 px-4">Статус</th>
                <th className="py-3 px-4 text-right">Сумма</th>
                <th className="py-3 px-4 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-sm">
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400 text-xs">
                    Операции не найдены
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((tx) => {
                  const catConf = categoryLabels[tx.category] || categoryLabels.other;
                  const isIncome = tx.type === 'income';

                  return (
                    <tr
                      key={tx.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors group"
                    >
                      {/* Title & Notes */}
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {tx.title}
                        </div>
                        {tx.notes && (
                          <div className="text-[11px] text-slate-400 truncate max-w-xs">
                            {tx.notes}
                          </div>
                        )}
                      </td>

                      {/* Category */}
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${catConf.colorClass}`}
                        >
                          {catConf.label}
                        </span>
                      </td>

                      {/* Date */}
                      <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-500">
                        {tx.date}
                      </td>

                      {/* Project / Client */}
                      <td className="py-3 px-4 text-xs">
                        {tx.projectName ? (
                          <span
                            onClick={() => {
                              if (tx.projectId) {
                                setSelectedProjectId(tx.projectId);
                                setActivePage('projects');
                              }
                            }}
                            className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer flex items-center gap-1 font-medium"
                          >
                            <FolderGit2 className="w-3 h-3" />
                            {tx.projectName}
                          </span>
                        ) : tx.clientName ? (
                          <span className="text-slate-600 dark:text-slate-300 font-medium">
                            {tx.clientName}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 text-xs">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                            tx.status === 'completed'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                              : tx.status === 'pending'
                              ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {tx.status === 'completed'
                            ? 'Проведено'
                            : tx.status === 'pending'
                            ? 'В обработке'
                            : 'Запланировано'}
                        </span>
                      </td>

                      {/* Amount */}
                      <td className="py-3 px-4 text-right font-mono font-bold tabular-nums">
                        <span
                          className={
                            isIncome
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-900 dark:text-white'
                          }
                        >
                          {isIncome ? '+' : '−'}
                          {formatMoney(tx.amount)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEditTransaction(tx)}
                            className="p-1 text-slate-400 hover:text-blue-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                            title="Редактировать"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteTransaction(tx.id)}
                            className="p-1 text-slate-400 hover:text-rose-600 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                            title="Удалить"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transaction Modal */}
      <TransactionModal />
    </div>
  );
};
