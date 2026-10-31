// Own fixture worker: its performance.now is real time, outside the virtual clock.
postMessage('worker-now:' + Math.round(performance.now()));
