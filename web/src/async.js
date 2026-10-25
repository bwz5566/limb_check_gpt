// Browsers cannot cancel getUserMedia; release any stream arriving after timeout.
export function deadline(promise, milliseconds, message, disposeLate = () => {}) {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error(message)); }, milliseconds);
    Promise.resolve(promise).then(value => {
      if (expired) disposeLate(value);
      else { clearTimeout(timer); resolve(value); }
    }, error => { if (!expired) { clearTimeout(timer); reject(error); } });
  });
}
