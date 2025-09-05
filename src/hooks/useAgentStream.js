import { useState, useEffect, useCallback, useRef } from 'react';
import AgentOrchestrator from '../services/AgentOrchestrator';

/**
 * Hook za streaming AI agent rezultata u real-time
 * @param {Array} tasks - Lista taskova za izvršavanje
 * @param {Function} onResult - Callback kad stigne rezultat
 * @param {Function} onError - Callback za greške
 * @param {Function} onComplete - Callback kad se završi stream
 */
export function useAgentStream(tasks, onResult, onError, onComplete) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState([]);

  const startStream = useCallback(() => {
    if (!tasks || tasks.length === 0) return;

    setIsStreaming(true);
    setProgress(0);
    setResults([]);

    const tasksParam = encodeURIComponent(JSON.stringify(tasks));
    const eventSource = new EventSource(`/api/agent/stream?tasks=${tasksParam}`);

    eventSource.addEventListener('start', (e) => {
      const data = JSON.parse(e.data);
      console.log(`🌊 Stream started for ${data.total} tasks`);
    });

    eventSource.addEventListener('result', (e) => {
      const data = JSON.parse(e.data);
      console.log(`✅ Result ${data.taskIndex}:`, data.result);
      
      setResults(prev => [...prev, data]);
      setProgress(data.progress || 0);
      
      if (onResult) onResult(data);
    });

    eventSource.addEventListener('error', (e) => {
      const data = JSON.parse(e.data);
      console.error(`❌ Task ${data.taskIndex} error:`, data.error);
      
      if (onError) onError(data);
    });

    eventSource.addEventListener('complete', (e) => {
      console.log('🏁 Stream completed');
      setIsStreaming(false);
      eventSource.close();
      
      if (onComplete) onComplete(results);
    });

    eventSource.onerror = (error) => {
      console.error('❌ EventSource error:', error);
      setIsStreaming(false);
      eventSource.close();
      
      if (onError) onError({ error: 'Stream connection failed' });
    };

    return () => {
      eventSource.close();
      setIsStreaming(false);
    };
  }, [tasks, onResult, onError, onComplete, results]);

  return {
    isStreaming,
    progress,
    results,
    startStream
  };
}

/**
 * Hook za multi-task batch processing (bez streaminga)
 */
export function useAgentMulti() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState([]);

  const processTasks = useCallback(async (tasks, files = []) => {
    if (!tasks || tasks.length === 0) return [];

    setIsProcessing(true);
    setResults([]);

    try {
      const formData = new FormData();
      formData.append('tasks', JSON.stringify(tasks));
      
      // Dodaj datoteke ako ih ima
      files.forEach((file, index) => {
        if (file) formData.append('files', file);
      });

      const response = await fetch('/api/agent/multi', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setResults(data.results);
      return data.results;

    } catch (error) {
      console.error('❌ Multi-task error:', error);
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, []);

  return {
    isProcessing,
    results,
    processTasks
  };
}

/**
 * Hook za smart routing (jedan input → auto-detektira tip)
 */
export function useSmartRoute() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const route = useCallback(async (prompt, file = null) => {
    setIsProcessing(true);
    setResult(null);

    try {
      const formData = new FormData();
      if (prompt) formData.append('prompt', prompt);
      if (file) formData.append('file', file);

      const response = await fetch('/api/agent/route', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setResult(data);
      return data;

    } catch (error) {
      console.error('❌ Route error:', error);
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, []);

  return {
    isProcessing,
    result,
    route
  };
}

/**
 * Advanced hook za orchestrator s local processing i routing
 */
export function useAgentOrchestrator() {
  const [results, setResults] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [orchestratorStats, setOrchestratorStats] = useState(null);
  const [error, setError] = useState(null);
  
  const orchestratorRef = useRef(null);
  const streamIdRef = useRef(null);

  // Inicijaliziraj orchestrator
  useEffect(() => {
    orchestratorRef.current = new AgentOrchestrator();
    
    return () => {
      if (streamIdRef.current) {
        orchestratorRef.current?.stopStream(streamIdRef.current);
      }
    };
  }, []);

  // Local streaming (koristi AgentOrchestrator)
  const processLocalStream = useCallback(async (tasks) => {
    if (!orchestratorRef.current) return;
    
    setIsProcessing(true);
    setResults([]);
    setError(null);
    
    const startTime = Date.now();
    streamIdRef.current = `local_stream_${startTime}`;
    
    try {
      await orchestratorRef.current.streamMultipleRequests(
        tasks,
        // onResult - čim stigne rezultat
        (resultData) => {          
          setResults(prev => {
            const newResults = [...prev];
            
            if (resultData.event === 'result') {
              newResults[resultData.taskId] = {
                taskId: resultData.taskId,
                status: 'completed',
                data: resultData.data,
                timestamp: resultData.timestamp
              };
            } else if (resultData.event === 'error') {
              newResults[resultData.taskId] = {
                taskId: resultData.taskId,
                status: 'failed', 
                error: resultData.error,
                timestamp: resultData.timestamp
              };
            }
            
            return newResults;
          });
        },
        // onComplete - sve završeno
        (stats) => {
          setOrchestratorStats({
            ...stats,
            totalDuration: Date.now() - startTime
          });
          
          setIsProcessing(false);
          streamIdRef.current = null;
        }
      );
      
    } catch (err) {
      console.error('❌ Local stream error:', err);
      setError(err.message);
      setIsProcessing(false);
    }
  }, []);

  // Batch processing (paralelno, ali čeka sve)
  const processBatch = useCallback(async (tasks) => {
    if (!orchestratorRef.current) return [];
    
    setIsProcessing(true);
    setResults([]);
    setError(null);
    
    try {
      const startTime = Date.now();
      const batchResults = await orchestratorRef.current.processMultipleRequests(tasks);
      
      setResults(batchResults.map((result, index) => ({
        taskId: index,
        status: result.status === 'fulfilled' ? 'completed' : 'failed',
        data: result.status === 'fulfilled' ? result.data : null,
        error: result.status === 'rejected' ? result.error : null
      })));
      
      setOrchestratorStats({
        totalTasks: tasks.length,
        completed: batchResults.filter(r => r.status === 'fulfilled').length,
        failed: batchResults.filter(r => r.status === 'rejected').length,
        totalDuration: Date.now() - startTime,
        mode: 'batch'
      });
      
      setIsProcessing(false);
      return batchResults;
      
    } catch (err) {
      console.error('❌ Batch error:', err);
      setError(err.message);
      setIsProcessing(false);
      return [];
    }
  }, []);

  // Jedan zahtjev s routing logikom
  const routeRequest = useCallback(async (input) => {
    if (!orchestratorRef.current) return null;
    
    try {
      const result = await orchestratorRef.current.routeLLMRequest(input);
      return result;
    } catch (err) {
      console.error('❌ Route error:', err);
      throw err;
    }
  }, []);

  const stopProcessing = useCallback(() => {
    if (orchestratorRef.current && streamIdRef.current) {
      orchestratorRef.current.stopStream(streamIdRef.current);
      setIsProcessing(false);
    }
  }, []);

  const getStats = useCallback(() => {
    return orchestratorRef.current?.getStats() || {};
  }, []);

  return {
    results,
    isProcessing,
    orchestratorStats,
    error,
    processLocalStream,
    processBatch,
    routeRequest,
    stopProcessing,
    getStats
  };
}

export default useAgentStream;