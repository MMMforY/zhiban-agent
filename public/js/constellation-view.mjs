export const categoryOrder = ['person', 'place', 'event', 'hobby', 'project'];
export const categoryLabels = {
  person: 'Social',
  place: 'Places',
  event: 'Events',
  hobby: 'Hobbies',
  project: 'Projects'
};
export const categoryColors = {
  person: '#ff9966',
  place: '#6699ff',
  event: '#66cc99',
  hobby: '#ffcc66',
  project: '#cc99ff'
};

function stablePhase(value) {
  let hash = 0;
  for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash % 628) / 100;
}

export function createConstellationView({
  canvas,
  onSelect = () => {},
  host = globalThis,
  documentRef = globalThis.document
}) {
  if (!canvas) throw new TypeError('canvas is required');
  const context = canvas.getContext('2d');
  const nodes = [];
  const motionQuery = host.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionQuery?.matches ?? false;
  let universe = null;
  let animationFrame = null;
  let destroyed = false;

  function buildLayout() {
    nodes.length = 0;
    if (!universe) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const center = { x: width * .5, y: height * .52 };
    const compact = width < 720;
    const radius = compact
      ? Math.max(150, Math.min(width * .42, height * .24))
      : Math.max(130, Math.min(width, height) * .34);

    universe.core.forEach((core, index) => {
      nodes.push({ ...core, kind: 'core', x: center.x + (index ? 44 : -44), y: center.y + (index ? 8 : -8), radius: 11 });
    });

    const groups = universe.constellations.reduce((result, item) => {
      (result[item.category] ||= []).push(item);
      return result;
    }, {});
    const orderedCategories = [...categoryOrder, ...Object.keys(groups).filter((category) => !categoryOrder.includes(category))];

    orderedCategories.forEach((category, categoryIndex) => {
      const group = groups[category] || [];
      const baseAngle = -Math.PI / 2 + categoryIndex * (Math.PI * 2 / Math.max(orderedCategories.length, 1));
      group.forEach((item, itemIndex) => {
        const spread = (itemIndex - (group.length - 1) / 2) * (compact ? .22 : .16);
        const ring = compact
          ? radius + (itemIndex - (group.length - 1) / 2) * 28
          : radius + (itemIndex % 3 - 1) * 54;
        const angle = baseAngle + spread;
        nodes.push({
          ...item,
          kind: 'constellation',
          x: center.x + Math.cos(angle) * ring,
          y: center.y + Math.sin(angle) * ring,
          radius: 7 + Math.min(9, Math.sqrt(item.fragmentCount || item.stars.length) * 2),
          phase: stablePhase(item.id || item.label)
        });
      });
    });
  }

  function resize() {
    const ratio = Math.min(host.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    buildLayout();
  }

  function stopAnimation() {
    if (animationFrame !== null) host.cancelAnimationFrame?.(animationFrame);
    animationFrame = null;
  }

  function shouldAnimate() {
    return !destroyed
      && !reducedMotion
      && documentRef?.visibilityState !== 'hidden'
      && Boolean(universe?.constellations?.length);
  }

  function drawBackground(width, height) {
    context.clearRect(0, 0, width, height);
    context.save();
    for (let index = 0; index < 150; index += 1) {
      const x = ((index * 137.5) % 1000) / 1000 * width;
      const y = ((index * 73.3) % 1000) / 1000 * height;
      const alpha = .12 + (index % 7) * .025;
      context.fillStyle = `rgba(206,231,227,${alpha})`;
      context.fillRect(x, y, index % 11 === 0 ? 1.5 : 1, index % 11 === 0 ? 1.5 : 1);
    }
    context.restore();
  }

  function draw(time = 0) {
    animationFrame = null;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    drawBackground(width, height);
    const core = nodes.filter((node) => node.kind === 'core');
    const centerX = core.length ? core.reduce((sum, node) => sum + node.x, 0) / core.length : width / 2;
    const centerY = core.length ? core.reduce((sum, node) => sum + node.y, 0) / core.length : height / 2;

    context.save();
    context.strokeStyle = 'rgba(141, 188, 181, .08)';
    nodes.filter((node) => node.kind === 'constellation').forEach((node) => {
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(node.x, node.y);
      context.stroke();
    });
    context.restore();

    for (const node of nodes) {
      const color = node.color || categoryColors[node.category] || '#9ab7b3';
      const pulse = reducedMotion || node.kind === 'core' ? 1 : 1 + Math.sin(time / 900 + node.phase) * .08;
      const radius = node.radius * pulse;
      const gradient = context.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius * 4);
      gradient.addColorStop(0, color);
      gradient.addColorStop(.2, `${color}88`);
      gradient.addColorStop(1, `${color}00`);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(node.x, node.y, radius * 4, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = color;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#dfecea';
      context.font = node.kind === 'core' ? '600 13px sans-serif' : '12px sans-serif';
      context.textAlign = 'center';
      context.fillText(node.name || node.label, node.x, node.y + radius + 19);
    }

    if (shouldAnimate()) animationFrame = host.requestAnimationFrame?.(draw) ?? null;
  }

  function render() {
    stopAnimation();
    draw();
  }

  function handleResize() {
    resize();
    render();
  }

  function handleVisibilityChange() {
    if (documentRef?.visibilityState === 'hidden') stopAnimation();
    else render();
  }

  function handleMotionPreferenceChange(event) {
    reducedMotion = Boolean(event.matches);
    render();
  }

  function nodeAt(event) {
    const rect = canvas.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return nodes.find((node) => Math.hypot(node.x - pointer.x, node.y - pointer.y) < node.radius + 10);
  }

  function handlePointerMove(event) {
    const hovered = nodeAt(event);
    canvas.style.cursor = hovered?.kind === 'constellation' ? 'pointer' : 'grab';
  }

  function handleClick(event) {
    const selected = nodeAt(event);
    if (selected?.kind === 'constellation') onSelect(selected);
  }

  function setUniverse(nextUniverse) {
    universe = nextUniverse;
    resize();
    render();
  }

  function clear() {
    universe = null;
    nodes.length = 0;
    render();
  }

  function destroy() {
    destroyed = true;
    stopAnimation();
    host.removeEventListener?.('resize', handleResize);
    documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    motionQuery?.removeEventListener?.('change', handleMotionPreferenceChange);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('click', handleClick);
  }

  host.addEventListener?.('resize', handleResize);
  documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
  motionQuery?.addEventListener?.('change', handleMotionPreferenceChange);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('click', handleClick);
  resize();
  render();

  return Object.freeze({ setUniverse, clear, destroy });
}
