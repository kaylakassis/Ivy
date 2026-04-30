// Tasks + Goals stores. Both fetched in parallel on mount.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useGoals() {
  const [tasks, setTasks] = useState([]);
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.get('/tasks'), api.get('/goals')])
      .then(([t, g]) => {
        if (!live) return;
        setTasks(t.tasks || []);
        setGoals(g.goals || []);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // ---- tasks ----
  const createTask = useCallback(async (input) => {
    const r = await api.post('/tasks', input);
    setTasks((xs) => [r.task, ...xs]);
    return r.task;
  }, []);
  const updateTask = useCallback(async (id, patch) => {
    const r = await api.patch('/tasks/' + id, patch);
    setTasks((xs) => xs.map((t) => t.id === id ? r.task : t));
    return r.task;
  }, []);
  const removeTask = useCallback(async (id) => {
    await api.del('/tasks/' + id);
    setTasks((xs) => xs.filter((t) => t.id !== id));
  }, []);
  const toggleTask = useCallback((task) => updateTask(task.id, { done: !task.done }), [updateTask]);

  // ---- goals ----
  const createGoal = useCallback(async (input) => {
    const r = await api.post('/goals', input);
    setGoals((xs) => [r.goal, ...xs]);
    return r.goal;
  }, []);
  const updateGoal = useCallback(async (id, patch) => {
    const r = await api.patch('/goals/' + id, patch);
    setGoals((xs) => xs.map((g) => g.id === id ? r.goal : g));
    return r.goal;
  }, []);
  const removeGoal = useCallback(async (id) => {
    await api.del('/goals/' + id);
    setGoals((xs) => xs.filter((g) => g.id !== id));
  }, []);

  return {
    tasks, goals, loading, error,
    createTask, updateTask, removeTask, toggleTask,
    createGoal, updateGoal, removeGoal,
  };
}
