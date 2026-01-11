/* UI animation helpers.
 * Kept separate from renderer.js to avoid mixing core UI logic with animation scripting.
 */

(function () {
  const prefersReducedMotion = () => {
    try {
      return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  const state = {
    viewTimer: null,
    lastActiveViewId: null
  };

  function updateNavActive(viewName) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
    document.querySelectorAll(`.nav-item[data-view="${viewName}"]`).forEach((b) => b.classList.add("is-active"));
  }

  function animateViewChange(viewName) {
    const next = document.getElementById(`view-${viewName}`);
    if (!next) return;

    updateNavActive(viewName);

    if (prefersReducedMotion()) {
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active", "is-entering", "is-leaving"));
      next.classList.add("is-active");
      return;
    }

    const current = document.querySelector(".view.is-active");
    if (current === next) return;

    // Cancel any in-flight animation cleanup.
    if (state.viewTimer) window.clearTimeout(state.viewTimer);

    // Remove transitional classes so we start from a clean state.
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-entering", "is-leaving"));

    // Animate current out (but keep it visible via is-leaving).
    if (current) {
      current.classList.add("is-leaving");
      current.classList.remove("is-active");
    }

    // Animate next in.
    next.classList.add("is-active", "is-entering");

    // Cleanup precisely on animation end, with a small fallback timer.
    let currentEnded = !current;
    let nextEnded = false;

    const cleanup = () => {
      if (current) current.classList.remove("is-leaving");
      next.classList.remove("is-entering");

      // Ensure only one active view.
      document.querySelectorAll(".view").forEach((v) => {
        if (v !== next) v.classList.remove("is-active", "is-entering", "is-leaving");
      });
      next.classList.add("is-active");
      state.viewTimer = null;
    };

    const maybeFinish = (force = false) => {
      if (force || (currentEnded && nextEnded)) cleanup();
    };

    const once = (el, cb) => {
      if (!el) return;
      el.addEventListener("animationend", cb, { once: true });
    };

    once(current, () => { currentEnded = true; maybeFinish(); });
    once(next, () => { nextEnded = true; maybeFinish(); });

    // Fallback in case animationend does not fire.
    state.viewTimer = window.setTimeout(() => maybeFinish(true), 260);
  }

  function observeListAnimations() {
    if (prefersReducedMotion()) return;

    const roots = [
      document.getElementById("tasks"),
      document.getElementById("accounts")
    ].filter(Boolean);

    roots.forEach((root) => {
      const obs = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          (m.addedNodes || []).forEach((n) => {
            if (!(n instanceof HTMLElement)) return;
            if (n.classList.contains("item")) {
              n.classList.add("anim-pop");
              window.setTimeout(() => n.classList.remove("anim-pop"), 220);
            }
          });
        });
      });
      obs.observe(root, { childList: true });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    observeListAnimations();
  });

  window.App = window.App || {};
  window.App.animateViewChange = animateViewChange;
})();
