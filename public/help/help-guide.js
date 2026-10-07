// A guide page: the menu and the phone's step numbers follow the step you
// are reading, screenshots open large, and "Did this guide help?" answers.
(() => {
  const steps = [...document.querySelectorAll(".step[id^='step-']")];
  const links = [...document.querySelectorAll("[data-step]")];
  const strip = document.querySelector(".step-strip");

  const setCurrent = (n) => {
    for (const link of links) {
      const at = Number(link.dataset.step);
      if (at === n) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
      link.classList.toggle("is-past", at < n);
    }
    const here = strip?.querySelector(`[data-step="${n}"]`);
    if (here && strip.scrollWidth > strip.clientWidth)
      strip.scrollTo({ left: here.offsetLeft - strip.clientWidth / 2 + here.offsetWidth / 2 });
  };

  // The step whose top has passed a line a little below the top of the
  // window; at the very bottom, the last one, which may never get that far.
  let ticking = false;
  const update = () => {
    ticking = false;
    if (!steps.length) return;
    const line = Math.min(innerHeight * 0.3, 220);
    let n = 1;
    for (const [i, step] of steps.entries()) if (step.getBoundingClientRect().top <= line) n = i + 1;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) n = steps.length;
    setCurrent(n);
  };
  addEventListener("scroll", () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  addEventListener("hashchange", update);
  update();

  // Screenshots open whole, uncropped, over the page.
  const dialog = document.querySelector(".zoom-dialog");
  if (dialog) {
    const img = dialog.querySelector(".zoom-img");
    const caption = dialog.querySelector(".zoom-caption");
    for (const button of document.querySelectorAll("[data-zoom]")) {
      button.addEventListener("click", () => {
        img.src = button.dataset.zoom;
        img.alt = button.dataset.alt || "";
        caption.textContent = button.dataset.alt || "";
        dialog.showModal();
      });
    }
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  for (const box of document.querySelectorAll("[data-feedback]")) {
    for (const button of box.querySelectorAll("[data-answer]")) {
      button.addEventListener("click", () => {
        for (const b of box.querySelectorAll("[data-answer]")) b.hidden = true;
        box.querySelector(".feedback-q").hidden = true;
        const thanks = box.querySelector(`[data-thanks="${button.dataset.answer}"]`);
        thanks.hidden = false;
        thanks.setAttribute("role", "status");
      });
    }
  }
})();
