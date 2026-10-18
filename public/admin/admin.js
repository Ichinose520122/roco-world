"use strict";

const state = {
  categories: [],
  images: [],
  query: "",
  category: "",
  filterState: "",
  selectedIds: new Set(),
  editOriginal: null,
  categoryDrafts: [],
  heroImageId: "",
  heroMode: "manual",
  recentLimit: 30,
  friends: [],
  friendAuthConfigured: true,
  comments: [],
  commentTotal: 0,
  unreadCommentCount: 0,
  activeFriendCount: 0,
};

const UPLOAD_CONCURRENCY = 10;

const elements = {
  summary: document.querySelector("#summary"),
  adminEmail: document.querySelector("#admin-email"),
  list: document.querySelector("#image-list"),
  empty: document.querySelector("#empty"),
  query: document.querySelector("#filter-query"),
  category: document.querySelector("#filter-category"),
  filterState: document.querySelector("#filter-state"),
  selectVisible: document.querySelector("#select-visible"),
  selectedCount: document.querySelector("#selected-count"),
  bulkCategory: document.querySelector("#bulk-category"),
  bulkMove: document.querySelector("#bulk-move"),
  bulkUntil: document.querySelector("#bulk-until"),
  clearSelection: document.querySelector("#clear-selection"),
  bulkButtons: [...document.querySelectorAll("[data-bulk-action]")],
  openUpload: document.querySelector("#open-upload"),
  openCategories: document.querySelector("#open-categories"),
  openMove: document.querySelector("#open-move"),
  openSiteSettings: document.querySelector("#open-site-settings"),
  openFriends: document.querySelector("#open-friends"),
  openComments: document.querySelector("#open-comments"),
  friendCount: document.querySelector("#friend-count"),
  unreadCommentCount: document.querySelector("#unread-comment-count"),
  categoryDialog: document.querySelector("#category-dialog"),
  categoryCreateForm: document.querySelector("#category-create-form"),
  categoryManagerList: document.querySelector("#category-manager-list"),
  applyCategorySettings: document.querySelector("#apply-category-settings"),
  moveDialog: document.querySelector("#move-dialog"),
  moveForm: document.querySelector("#move-form"),
  uploadDialog: document.querySelector("#upload-dialog"),
  uploadForm: document.querySelector("#upload-form"),
  editDialog: document.querySelector("#edit-dialog"),
  editForm: document.querySelector("#edit-form"),
  deleteButton: document.querySelector("#delete-button"),
  siteSettingsDialog: document.querySelector("#site-settings-dialog"),
  siteSettingsForm: document.querySelector("#site-settings-form"),
  manualHeroNote: document.querySelector("#manual-hero-note"),
  friendsDialog: document.querySelector("#friends-dialog"),
  friendCreateForm: document.querySelector("#friend-create-form"),
  friendManagerList: document.querySelector("#friend-manager-list"),
  friendConfigWarning: document.querySelector("#friend-config-warning"),
  friendManagerMessage: document.querySelector("#friend-manager-message"),
  commentsDialog: document.querySelector("#comments-dialog"),
  commentManagerList: document.querySelector("#comment-manager-list"),
  commentManagerSummary: document.querySelector("#comment-manager-summary"),
  markAllCommentsRead: document.querySelector("#mark-all-comments-read"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindControls();
  setDefaultUploadTime();
  await loadGallery();
  window.setInterval(() => {
    if (!document.hidden) refreshCommentBadge();
  }, 60_000);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

async function loadGallery() {
  elements.list.setAttribute("aria-busy", "true");
  try {
    const data = await request("/api/admin/gallery");
    state.categories = data.categories || [];
    state.images = data.images || [];
    state.heroImageId = data.settings?.heroImageId || "";
    state.heroMode = ["manual", "featured", "all"].includes(data.settings?.heroMode)
      ? data.settings.heroMode
      : "manual";
    state.recentLimit = [30, 50, 100].includes(Number(data.settings?.recentLimit))
      ? Number(data.settings.recentLimit)
      : 30;
    state.unreadCommentCount = Number(data.stats?.unreadCommentCount || 0);
    state.activeFriendCount = Number(data.stats?.activeFriendCount || 0);
    const availableIds = new Set(state.images.map((image) => image.id));
    state.selectedIds = new Set([...state.selectedIds].filter((id) => availableIds.has(id)));
    elements.adminEmail.textContent = data.admin || "";
    populateCategories();
    renderAdminSignals();
    render();
    if (elements.categoryDialog.open) startCategoryDraft();
  } catch (error) {
    showToast(error.message, true);
    elements.summary.textContent = "后台数据读取失败";
  } finally {
    elements.list.setAttribute("aria-busy", "false");
  }
}

function populateCategories() {
  const selects = [
    elements.category,
    elements.uploadForm.elements.category,
    elements.editForm.elements.category,
    elements.moveForm.elements.fromCategory,
    elements.moveForm.elements.toCategory,
    elements.bulkCategory,
  ];
  selects.forEach((select, index) => {
    const current = select.value;
    if (index === 0) select.replaceChildren(new Option("全部分类", ""));
    else if (select === elements.bulkCategory) select.replaceChildren(new Option("选择目标分组", ""));
    else select.replaceChildren();
    state.categories.forEach((category) => {
      const label = category.visible ? category.name : `${category.name}（已隐藏）`;
      select.add(new Option(label, category.id));
    });
    select.value = current;
  });

  if (state.category && !state.categories.some((category) => category.id === state.category)) {
    state.category = "";
    elements.category.value = "";
  }
}

function filteredImages() {
  const query = state.query.trim().toLocaleLowerCase("zh-CN");
  return state.images.filter((image) => {
    if (state.category && !imageMatchesCategory(image, state.category)) return false;
    if (state.filterState === "pinned" && !image.pinned) return false;
    if (state.filterState === "featured" && !image.featured) return false;
    if (!query) return true;
    return [image.title, image.comment, image.time, image.categoryName, ...(image.tags || [])]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(query);
  });
}

function imageMatchesCategory(image, categoryId) {
  const category = state.categories.find((item) => item.id === categoryId);
  if (!category) return false;
  if (image.categoryId) return image.categoryId === category.id;
  return [category.id, category.name, ...(category.aliases || [])].includes(image.category);
}

function render() {
  const images = filteredImages();
  elements.list.replaceChildren();
  images.forEach((image) => elements.list.append(createRow(image)));
  elements.empty.hidden = images.length !== 0;
  elements.list.hidden = images.length === 0;
  const pinned = state.images.filter((image) => image.pinned).length;
  const featured = state.images.filter((image) => image.featured).length;
  elements.summary.textContent = `${state.images.length} 张图片 · ${pinned} 张置顶 · ${featured} 张精选`;
  renderSelectionState(images);
}

function createRow(image) {
  const row = document.createElement("article");
  row.className = "image-row";
  row.classList.toggle("is-selected", state.selectedIds.has(image.id));
  row.classList.toggle("is-hero", state.heroMode === "manual" && state.heroImageId === image.id);

  const selection = document.createElement("label");
  selection.className = "row-select";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selectedIds.has(image.id);
  checkbox.setAttribute("aria-label", `选择：${image.title || image.categoryName}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedIds.add(image.id);
    else state.selectedIds.delete(image.id);
    render();
  });
  selection.append(checkbox);

  const picture = document.createElement("img");
  picture.alt = image.title || image.categoryName;
  picture.loading = "lazy";
  picture.decoding = "async";
  picture.src = image.thumbnailUrl || image.url;

  const main = document.createElement("div");
  main.className = "row-main";
  const title = document.createElement("strong");
  title.textContent = image.title || "未命名瞬间";
  const time = document.createElement("span");
  time.textContent = formatDisplayTime(image.time);
  main.append(title, time);
  if (image.comment) {
    const comment = document.createElement("p");
    comment.textContent = image.comment;
    main.append(comment);
  }
  const badges = document.createElement("div");
  badges.className = "badges";
  if (image.pinnedEnabled) badges.append(makeBadge(image.pinned ? "置顶" : "置顶已到期"));
  if (image.featuredEnabled) badges.append(makeBadge(image.featured ? "精选" : "精选已到期"));
  if (state.heroMode === "manual" && state.heroImageId === image.id) {
    badges.append(makeBadge("固定标题图"));
  }
  (image.tags || []).forEach((tag) => badges.append(makeBadge(`# ${tag}`)));
  main.append(badges);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const category = document.createElement("span");
  category.textContent = image.categoryName;
  const size = document.createElement("span");
  size.textContent = formatBytes(image.size);
  meta.append(category, size);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openEdit(image));

  const hero = document.createElement("button");
  hero.type = "button";
  const isHero = state.heroMode === "manual" && state.heroImageId === image.id;
  hero.textContent = isHero ? "取消固定标题图" : "设为固定标题图";
  hero.className = isHero ? "quiet" : "";
  hero.addEventListener("click", () => setHeroImage(image, hero));

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(hero, edit);
  row.append(selection, picture, main, meta, actions);
  return row;
}

async function setHeroImage(image, button) {
  const removing = state.heroMode === "manual" && state.heroImageId === image.id;
  const description = removing
    ? "取消当前网页顶部标题图"
    : `把这张照片设为网页顶部标题图`;
  if (!confirm(`${description}吗？`)) return;

  button.disabled = true;
  try {
    await request("/api/admin/site-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        heroImageId: removing ? "" : image.id,
        heroMode: "manual",
        recentLimit: state.recentLimit,
      }),
    });
    await loadGallery();
    showToast(removing ? "已取消网页标题图" : "网页标题图已更新");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderSelectionState(visibleImages = filteredImages()) {
  const selectedCount = state.selectedIds.size;
  const visibleIds = visibleImages.map((image) => image.id);
  const visibleSelected = visibleIds.filter((id) => state.selectedIds.has(id)).length;
  elements.selectedCount.textContent = `已选 ${selectedCount} 张`;
  elements.selectVisible.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  elements.selectVisible.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  elements.selectVisible.disabled = visibleIds.length === 0;
  elements.bulkMove.disabled = selectedCount === 0 || !elements.bulkCategory.value;
  elements.clearSelection.disabled = selectedCount === 0;
  elements.bulkButtons.forEach((button) => { button.disabled = selectedCount === 0; });
}

function makeBadge(text) {
  const badge = document.createElement("b");
  badge.textContent = text;
  return badge;
}

function renderAdminSignals() {
  elements.friendCount.textContent = String(state.activeFriendCount);
  elements.unreadCommentCount.textContent = String(state.unreadCommentCount);
  elements.unreadCommentCount.hidden = state.unreadCommentCount === 0;
  elements.openComments.classList.toggle("has-notification", state.unreadCommentCount > 0);
}

function bindControls() {
  elements.query.addEventListener("input", (event) => {
    state.query = event.target.value;
    render();
  });
  elements.category.addEventListener("change", (event) => {
    state.category = event.target.value;
    render();
  });
  elements.filterState.addEventListener("change", (event) => {
    state.filterState = event.target.value;
    render();
  });
  elements.selectVisible.addEventListener("change", () => {
    const visibleIds = filteredImages().map((image) => image.id);
    visibleIds.forEach((id) => {
      if (elements.selectVisible.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
    });
    render();
  });
  elements.bulkCategory.addEventListener("change", () => renderSelectionState());
  elements.bulkMove.addEventListener("click", () => runBulkAction("move"));
  elements.bulkButtons.forEach((button) => {
    button.addEventListener("click", () => runBulkAction(button.dataset.bulkAction));
  });
  elements.clearSelection.addEventListener("click", () => {
    state.selectedIds.clear();
    render();
  });

  elements.openUpload.addEventListener("click", () => elements.uploadDialog.showModal());
  elements.openCategories.addEventListener("click", () => {
    startCategoryDraft();
    elements.categoryDialog.showModal();
  });
  elements.openMove.addEventListener("click", () => {
    syncMoveTargets();
    elements.moveDialog.showModal();
  });
  elements.openSiteSettings.addEventListener("click", openSiteSettings);
  elements.openFriends.addEventListener("click", async () => {
    showFriendManagerMessage("");
    elements.friendsDialog.showModal();
    await loadFriends();
  });
  elements.openComments.addEventListener("click", async () => {
    elements.commentsDialog.showModal();
    await loadCommentsManager();
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close());
  });

  setupScheduleControls(elements.uploadForm);
  setupScheduleControls(elements.editForm);
  elements.uploadForm.elements.file.addEventListener("change", (event) => {
  const files = [...event.target.files];

  if (!files.length) return;

  const parsedTime = parseScreenshotTimeFromFilename(files[0].name);

  if (!parsedTime) {
    showToast(
      `无法从“${files[0].name}”读取时间，将使用手动填写的截图时间`,
      true,
    );
    return;
  }

  /*
   * datetime-local 需要：
   * 2026-07-12T00:27:17
   */
  elements.uploadForm.elements.time.value =
    parsedTime.replace(" ", "T");

  if (files.length === 1) {
    showToast(`已读取截图时间：${parsedTime}`);
  } else {
    showToast(
      `已选择 ${files.length} 张图片，每张图片将分别读取文件名时间`,
    );
  }
});
  elements.uploadForm.addEventListener("submit", submitUpload);
  elements.editForm.addEventListener("submit", submitEdit);
  elements.deleteButton.addEventListener("click", deleteCurrent);

  elements.moveForm.elements.fromCategory.addEventListener("change", syncMoveTargets);
  elements.moveForm.addEventListener("submit", moveCategory);
  elements.categoryCreateForm.addEventListener("submit", createCategory);
  elements.applyCategorySettings.addEventListener("click", applyCategorySettings);
  elements.siteSettingsForm.addEventListener("submit", submitSiteSettings);
  elements.friendCreateForm.addEventListener("submit", createFriend);
  elements.markAllCommentsRead.addEventListener("click", markAllCommentsRead);
}

function startCategoryDraft() {
  state.categoryDrafts = state.categories.map((category) => ({ ...category }));
  renderCategoryManager();
}

function categoryDraftChanged() {
  if (state.categoryDrafts.length !== state.categories.length) return true;
  return state.categoryDrafts.some((draft, index) => {
    const original = state.categories[index];
    return !original
      || draft.id !== original.id
      || draft.name.trim() !== original.name
      || draft.visible !== original.visible;
  });
}

function syncCategoryApplyState() {
  elements.applyCategorySettings.disabled = !categoryDraftChanged();
}

function renderCategoryManager() {
  elements.categoryManagerList.replaceChildren();
  state.categoryDrafts.forEach((category, index) => {
    const row = document.createElement("article");
    row.className = "category-manager-row";

    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 60;
    name.value = category.name;
    name.setAttribute("aria-label", `${category.name}的分组名称`);
    name.addEventListener("input", () => {
      category.name = name.value;
      syncCategoryApplyState();
    });

    const visibleLabel = document.createElement("label");
    visibleLabel.className = "category-visible";
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = category.visible;
    visible.addEventListener("change", () => {
      category.visible = visible.checked;
      syncCategoryApplyState();
    });
    visibleLabel.append(visible, document.createTextNode("公开显示"));

    const count = document.createElement("span");
    count.className = "category-count";
    count.textContent = `${category.imageCount || 0} 张`;

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.title = "向上移动";
    up.disabled = index === 0;
    up.addEventListener("click", () => reorderCategory(index, index - 1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.title = "向下移动";
    down.disabled = index === state.categoryDrafts.length - 1;
    down.addEventListener("click", () => reorderCategory(index, index + 1));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.disabled = Number(category.imageCount || 0) > 0;
    remove.title = remove.disabled ? "请先迁移这个分组中的图片" : "删除空分组";
    remove.addEventListener("click", () => deleteCategory(category, remove));

    row.append(name, visibleLabel, count, up, down, remove);
    elements.categoryManagerList.append(row);
  });
  syncCategoryApplyState();
}

async function createCategory(event) {
  event.preventDefault();
  if (categoryDraftChanged()) {
    showToast("请先确定应用或取消当前分组修改", true);
    return;
  }
  const submit = event.submitter;
  const name = elements.categoryCreateForm.elements.name.value.trim();
  if (!name) return;
  submit.disabled = true;
  try {
    await request("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    elements.categoryCreateForm.reset();
    await loadGallery();
    showToast(`已新增分组“${name}”`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function applyCategorySettings() {
  if (!categoryDraftChanged()) return;
  const categories = state.categoryDrafts.map((category) => ({
    id: category.id,
    name: category.name.trim(),
    visible: category.visible,
  }));
  if (categories.some((category) => !category.name)) {
    showToast("分组名称不能为空", true);
    return;
  }
  elements.applyCategorySettings.disabled = true;
  try {
    await request("/api/admin/category-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories }),
    });
    await loadGallery();
    elements.categoryDialog.close();
    showToast("分组名称、显示状态和顺序已一次性应用");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    syncCategoryApplyState();
  }
}

function reorderCategory(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.categoryDrafts.length) return;
  const [moved] = state.categoryDrafts.splice(fromIndex, 1);
  state.categoryDrafts.splice(toIndex, 0, moved);
  renderCategoryManager();
}

async function deleteCategory(category, button) {
  if (categoryDraftChanged()) {
    showToast("请先确定应用或取消当前分组修改", true);
    return;
  }
  if (!confirm(`确定删除空分组“${category.name}”吗？`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/categories/${encodeURIComponent(category.id)}`, {
      method: "DELETE",
    });
    await loadGallery();
    showToast(`已删除分组“${category.name}”`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

const BULK_LABELS = Object.freeze({
  move: "移动分组",
  "feature-on": "设为精选",
  "feature-off": "取消精选",
  "pin-on": "置顶",
  "pin-off": "取消置顶",
});

async function runBulkAction(action) {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  const category = elements.bulkCategory.value;
  if (action === "move" && !category) {
    showToast("请先选择目标分组", true);
    return;
  }

  const categoryName = state.categories.find((item) => item.id === category)?.name || category;
  const description = action === "move"
    ? `把选中的 ${ids.length} 张图片移动到“${categoryName}”`
    : `对选中的 ${ids.length} 张图片执行“${BULK_LABELS[action]}”`;
  if (!confirm(`${description}吗？`)) return;

  const controls = [elements.bulkMove, ...elements.bulkButtons, elements.clearSelection];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await request("/api/admin/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids,
        action,
        ...(action === "move" ? { category } : {}),
        ...(["feature-on", "pin-on"].includes(action)
          ? { until: fromLocalInput(elements.bulkUntil.value) }
          : {}),
      }),
    });
    state.selectedIds.clear();
    await loadGallery();
    showToast(`批量操作完成，共更新 ${result.changed} 张图片`);
  } catch (error) {
    showToast(error.message, true);
    renderSelectionState();
  }
}

function syncMoveTargets() {
  const from = elements.moveForm.elements.fromCategory.value;
  const target = elements.moveForm.elements.toCategory;
  [...target.options].forEach((option) => {
    option.disabled = option.value === from;
  });
  if (!target.value || target.value === from) {
    target.value = [...target.options].find((option) => !option.disabled)?.value || "";
  }
}

async function moveCategory(event) {
  event.preventDefault();
  const submit = event.submitter;
  const fromCategory = elements.moveForm.elements.fromCategory.value;
  const toCategory = elements.moveForm.elements.toCategory.value;
  const fromName = state.categories.find((item) => item.id === fromCategory)?.name || fromCategory;
  const toName = state.categories.find((item) => item.id === toCategory)?.name || toCategory;
  const count = state.images.filter((image) => image.category === fromCategory).length;

  if (!count) {
    showToast("来源组中没有图片", true);
    return;
  }
  if (!confirm(`确定把“${fromName}”中的 ${count} 张图片全部移到“${toName}”吗？`)) return;

  submit.disabled = true;
  try {
    const result = await request("/api/admin/move-category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromCategory, toCategory }),
    });
    elements.moveDialog.close();
    await loadGallery();
    showToast(`已迁移 ${result.moved} 张图片到“${toName}”`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

function openSiteSettings() {
  const form = elements.siteSettingsForm.elements;
  form.heroMode.value = state.heroMode;
  form.recentLimit.value = String(state.recentLimit);
  const hero = state.images.find((image) => image.id === state.heroImageId);
  elements.manualHeroNote.textContent = hero
    ? `当前固定照片：${hero.title || hero.categoryName} · ${formatDisplayTime(hero.time)}`
    : "尚未指定固定标题照片，可以在图片列表中点击“设为固定标题图”。";
  elements.siteSettingsDialog.showModal();
}

async function submitSiteSettings(event) {
  event.preventDefault();
  const submit = event.submitter;
  const form = elements.siteSettingsForm.elements;
  submit.disabled = true;
  try {
    await request("/api/admin/site-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        heroImageId: state.heroImageId,
        heroMode: form.heroMode.value,
        recentLimit: Number(form.recentLimit.value),
      }),
    });
    elements.siteSettingsDialog.close();
    await loadGallery();
    showToast("网站标题照片和最近更新设置已保存");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function refreshCommentBadge() {
  try {
    const data = await request("/api/admin/comments?summary=1", { cache: "no-store" });
    state.unreadCommentCount = Number(data.unreadCount || 0);
    renderAdminSignals();
  } catch (error) {
    console.warn(error);
  }
}

async function loadFriends() {
  elements.friendManagerList.setAttribute("aria-busy", "true");
  elements.friendManagerList.replaceChildren(makeManagerMessage("正在读取好友名单…"));
  try {
    const data = await request("/api/admin/friends", { cache: "no-store" });
    state.friends = data.friends || [];
    state.friendAuthConfigured = data.configured !== false;
    state.activeFriendCount = state.friends.filter((friend) => friend.active).length;
    renderFriendConfiguration();
    renderAdminSignals();
    renderFriendManager();
  } catch (error) {
    elements.friendManagerList.replaceChildren(makeManagerMessage(error.message, true));
    showFriendManagerMessage(error.message, true);
  } finally {
    elements.friendManagerList.setAttribute("aria-busy", "false");
  }
}

function renderFriendConfiguration() {
  elements.friendConfigWarning.hidden = state.friendAuthConfigured;
  [...elements.friendCreateForm.elements].forEach((control) => {
    control.disabled = !state.friendAuthConfigured;
  });
}

function showFriendManagerMessage(message, error = false) {
  elements.friendManagerMessage.hidden = !message;
  elements.friendManagerMessage.textContent = message;
  elements.friendManagerMessage.classList.toggle("is-error", Boolean(message) && error);
}

function renderFriendManager() {
  elements.friendManagerList.replaceChildren();
  if (!state.friends.length) {
    elements.friendManagerList.append(makeManagerMessage("还没有好友，请先在上方添加。"));
    return;
  }
  state.friends.forEach((friend) => elements.friendManagerList.append(createFriendManagerRow(friend)));
}

function createFriendManagerRow(friend) {
  const form = document.createElement("form");
  form.className = "friend-manager-row";
  form.dataset.friendId = friend.id;

  const name = document.createElement("input");
  name.name = "displayName";
  name.maxLength = 40;
  name.value = friend.displayName;
  name.setAttribute("aria-label", `${friend.displayName}的游戏名称`);
  const studentId = document.createElement("input");
  studentId.name = "studentId";
  studentId.maxLength = 80;
  studentId.placeholder = state.friendAuthConfigured
    ? "新学号（不修改请留空）"
    : "请先配置 FRIEND_ID_SECRET";
  studentId.disabled = !state.friendAuthConfigured;
  studentId.setAttribute("aria-label", `${friend.displayName}的新学号`);

  const activeLabel = document.createElement("label");
  activeLabel.className = "friend-active";
  const active = document.createElement("input");
  active.type = "checkbox";
  active.name = "active";
  active.checked = friend.active;
  activeLabel.append(active, document.createTextNode("允许登录"));

  const verifiedLabel = document.createElement("label");
  verifiedLabel.className = "friend-active";
  const verified = document.createElement("input");
  verified.type = "checkbox";
  verified.name = "verified";
  verified.checked = friend.verified === true;
  verifiedLabel.append(verified, document.createTextNode("已认证"));
  const permissions = document.createElement("div");
  permissions.className = "friend-permissions";
  permissions.append(activeLabel, verifiedLabel);

  const meta = document.createElement("p");
  const loginText = friend.lastLoginAt
    ? `最近登录 ${formatDisplayTime(friend.lastLoginAt)}`
    : "尚未登录";
  meta.textContent = `${friend.verified ? "已认证" : "待认证"} · ${friend.commentCount} 条留言 · ${friend.activeSessions} 个会话 · ${loginText}`;

  const actions = document.createElement("div");
  actions.className = "manager-row-actions";
  const save = document.createElement("button");
  save.className = "primary";
  save.type = "submit";
  save.textContent = "保存";
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.textContent = "退出所有设备";
  revoke.disabled = friend.activeSessions === 0;
  revoke.addEventListener("click", () => revokeFriendSessions(friend, revoke));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", () => deleteFriend(friend, remove));
  actions.append(save, revoke, remove);
  form.append(name, studentId, permissions, meta, actions);
  form.addEventListener("submit", (event) => saveFriend(event, friend));
  return form;
}

async function createFriend(event) {
  event.preventDefault();
  const submit = event.submitter;
  const form = elements.friendCreateForm.elements;
  submit.disabled = true;
  try {
    await request("/api/admin/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: form.displayName.value,
        studentId: form.studentId.value,
      }),
    });
    elements.friendCreateForm.reset();
    await loadFriends();
    showFriendManagerMessage("好友已添加，可以使用游戏名称和学号登录");
  } catch (error) {
    if (error.message.includes("FRIEND_ID_SECRET")) {
      state.friendAuthConfigured = false;
      renderFriendConfiguration();
    }
    showFriendManagerMessage(error.message, true);
  } finally {
    submit.disabled = !state.friendAuthConfigured;
  }
}

async function saveFriend(event, friend) {
  event.preventDefault();
  const submit = event.submitter;
  const form = event.currentTarget.elements;
  submit.disabled = true;
  try {
    await request(`/api/admin/friends/${encodeURIComponent(friend.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: form.displayName.value,
        studentId: form.studentId.value,
        active: form.active.checked,
        verified: form.verified.checked,
      }),
    });
    await loadFriends();
    showFriendManagerMessage("好友资料已保存");
  } catch (error) {
    if (error.message.includes("FRIEND_ID_SECRET")) {
      state.friendAuthConfigured = false;
      renderFriendConfiguration();
    }
    showFriendManagerMessage(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function revokeFriendSessions(friend, button) {
  if (!confirm(`让“${friend.displayName}”在所有设备退出登录吗？`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/friends/${encodeURIComponent(friend.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revokeSessions: true }),
    });
    await loadFriends();
    showFriendManagerMessage("该好友的登录状态已全部清除");
  } catch (error) {
    showFriendManagerMessage(error.message, true);
    button.disabled = false;
  }
}

async function deleteFriend(friend, button) {
  if (!confirm(`确定从好友名单删除“${friend.displayName}”吗？已有留言会保留。`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/friends/${encodeURIComponent(friend.id)}`, { method: "DELETE" });
    await loadFriends();
    showFriendManagerMessage("好友已删除，历史留言仍然保留");
  } catch (error) {
    showFriendManagerMessage(error.message, true);
    button.disabled = false;
  }
}

async function loadCommentsManager() {
  elements.commentManagerList.setAttribute("aria-busy", "true");
  elements.commentManagerList.replaceChildren(makeManagerMessage("正在读取好友留言…"));
  try {
    const data = await request("/api/admin/comments", { cache: "no-store" });
    state.comments = data.comments || [];
    state.commentTotal = Number(data.total || 0);
    state.unreadCommentCount = Number(data.unreadCount || 0);
    renderAdminSignals();
    renderCommentManager();
  } catch (error) {
    elements.commentManagerList.replaceChildren(makeManagerMessage(error.message, true));
  } finally {
    elements.commentManagerList.setAttribute("aria-busy", "false");
  }
}

function renderCommentManager() {
  elements.commentManagerList.replaceChildren();
  elements.commentManagerSummary.textContent = `${state.commentTotal} 条留言 · ${state.unreadCommentCount} 条未读`;
  elements.markAllCommentsRead.disabled = state.unreadCommentCount === 0;
  if (!state.comments.length) {
    elements.commentManagerList.append(makeManagerMessage("还没有收到好友留言。"));
    return;
  }
  state.comments.forEach((comment) => {
    const row = document.createElement("article");
    row.className = "comment-manager-row";
    row.classList.toggle("is-unread", !comment.read);

    const photo = document.createElement("a");
    photo.href = `/?photo=${encodeURIComponent(comment.imageId)}`;
    photo.target = "_blank";
    photo.rel = "noopener noreferrer";
    photo.title = "在公开图库中打开照片";
    const image = document.createElement("img");
    image.src = comment.imageUrl;
    image.alt = comment.imageTitle;
    image.loading = "lazy";
    photo.append(image);

    const content = document.createElement("div");
    content.className = "comment-manager-content";
    const heading = document.createElement("div");
    const author = document.createElement("strong");
    author.textContent = `${comment.authorName} · ${comment.authorVerified ? "已认证" : "待认证"}`;
    const time = document.createElement("span");
    time.textContent = formatDisplayTime(comment.createdAt);
    heading.append(author, time);
    const message = document.createElement("p");
    message.textContent = comment.content;
    const photoMeta = document.createElement("small");
    photoMeta.textContent = `${comment.categoryName} · ${comment.imageTitle} · ${formatDisplayTime(comment.imageTime)}`;
    content.append(heading, message, photoMeta);

    const actions = document.createElement("div");
    actions.className = "manager-row-actions";
    if (!comment.read) {
      const read = document.createElement("button");
      read.type = "button";
      read.textContent = "标为已读";
      read.addEventListener("click", () => markCommentRead(comment, read));
      actions.append(read);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteAdminComment(comment, remove));
    actions.append(remove);
    row.append(photo, content, actions);
    elements.commentManagerList.append(row);
  });
}

async function markCommentRead(comment, button) {
  button.disabled = true;
  try {
    await request(`/api/admin/comments/${encodeURIComponent(comment.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    comment.read = true;
    state.unreadCommentCount = Math.max(0, state.unreadCommentCount - 1);
    renderAdminSignals();
    renderCommentManager();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function markAllCommentsRead() {
  elements.markAllCommentsRead.disabled = true;
  try {
    await request("/api/admin/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark-all-read" }),
    });
    state.comments.forEach((comment) => { comment.read = true; });
    state.unreadCommentCount = 0;
    renderAdminSignals();
    renderCommentManager();
    showToast("全部留言已标为已读");
  } catch (error) {
    showToast(error.message, true);
    elements.markAllCommentsRead.disabled = false;
  }
}

async function deleteAdminComment(comment, button) {
  if (!confirm(`确定删除“${comment.authorName}”的这条留言吗？`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/comments/${encodeURIComponent(comment.id)}`, { method: "DELETE" });
    state.comments = state.comments.filter((item) => item.id !== comment.id);
    state.commentTotal = Math.max(0, state.commentTotal - 1);
    if (!comment.read) state.unreadCommentCount = Math.max(0, state.unreadCommentCount - 1);
    renderAdminSignals();
    renderCommentManager();
    showToast("留言已删除");
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

function makeManagerMessage(message, error = false) {
  const paragraph = document.createElement("p");
  paragraph.className = `manager-empty${error ? " is-error" : ""}`;
  paragraph.textContent = message;
  return paragraph;
}

function setupScheduleControls(form) {
  ["pinned", "featured"].forEach((name) => {
    const enabled = form.elements[`${name}Enabled`];
    const until = form.elements[`${name}Until`];
    const sync = () => {
      until.disabled = !enabled.checked;
      if (!enabled.checked) until.value = "";
    };
    enabled.addEventListener("change", sync);
    sync();
  });
}

function parseScreenshotTimeFromFilename(filename) {
  const match = String(filename).match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:[_.-]|$)/,
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
    || date.getSeconds() !== Number(second)
  ) {
    return null;
  }

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

async function submitUpload(event) {
  event.preventDefault();

  const submit = event.submitter;
  const fileInput = elements.uploadForm.elements.file;
  const files = [...fileInput.files];

  if (!files.length) {
    showToast("请选择至少一张图片", true);
    return;
  }

  submit.disabled = true;

  const originalText = submit.textContent;
  let uploaded = 0;
  let completed = 0;
  const failures = [];
  const fallbackTime = fromLocalInput(
    elements.uploadForm.elements.time.value,
  );

  try {
    /*
     * 获取所有图片共用的字段。
     * file 和 time 会在循环中为每张图片单独设置。
     */
    const baseForm = new FormData(elements.uploadForm);

    baseForm.delete("file");
    baseForm.delete("time");

    normalizeFormDates(baseForm);

    baseForm.set(
      "pinnedEnabled",
      String(elements.uploadForm.elements.pinnedEnabled.checked),
    );

    baseForm.set(
      "featuredEnabled",
      String(elements.uploadForm.elements.featuredEnabled.checked),
    );

    submit.textContent = `正在并发上传 0/${files.length}`;
    const uploadOne = async (file) => {
      const screenshotTime =
        parseScreenshotTimeFromFilename(file.name)
        || fallbackTime;

      if (!screenshotTime) {
        failures.push({
          name: file.name,
          message: "无法从文件名读取时间，且未填写备用截图时间",
        });
        completed += 1;
        submit.textContent = `正在并发上传 ${completed}/${files.length}`;
        return;
      }

      const form = new FormData();

      for (const [name, value] of baseForm.entries()) {
        form.append(name, value);
      }

      form.set("file", file, file.name);
      form.set("time", screenshotTime);
      form.set("refreshSnapshot", "false");
      form.set("minimalResponse", "true");

      try {
        await request("/api/admin/upload", {
          method: "POST",
          body: form,
        });

        uploaded += 1;
      } catch (error) {
        failures.push({
          name: file.name,
          message: error.message,
        });
      } finally {
        completed += 1;
        submit.textContent = `正在并发上传 ${completed}/${files.length}`;
      }
    };

    await runWithConcurrency(files, UPLOAD_CONCURRENCY, uploadOne);

    if (uploaded > 0) {
      submit.textContent = "正在刷新图库索引";
      await request("/api/admin/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    }

    await loadGallery();

    if (!failures.length) {
      elements.uploadDialog.close();
      elements.uploadForm.reset();
      setupFormAfterReset(elements.uploadForm);
      setDefaultUploadTime();

      showToast(
        `已上传 ${uploaded} 张图片，截图时间已从文件名读取`,
      );

      return;
    }

    const failureDetails = failures
      .slice(0, 3)
      .map((failure) => `${failure.name}：${failure.message}`)
      .join("；");

    const remaining =
      failures.length > 3
        ? `；另有 ${failures.length - 3} 张失败`
        : "";

    showToast(
      `成功 ${uploaded} 张，失败 ${failures.length} 张。${failureDetails}${remaining}`,
      true,
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = originalText;
  }
}

function openEdit(image) {
  const form = elements.editForm.elements;
  state.editOriginal = {
    id: image.id,
    category: image.category,
    time: toLocalInput(image.time),
    title: image.title || "",
    comment: image.comment || "",
    tags: (image.tags || []).join(", "),
    pinnedEnabled: Boolean(image.pinnedEnabled),
    pinnedUntil: toLocalInput(image.pinnedUntil),
    featuredEnabled: Boolean(image.featuredEnabled),
    featuredUntil: toLocalInput(image.featuredUntil),
  };
  form.id.value = image.id;
  form.category.value = state.editOriginal.category;
  form.time.value = state.editOriginal.time;
  form.title.value = state.editOriginal.title;
  form.comment.value = state.editOriginal.comment;
  form.tags.value = state.editOriginal.tags;
  form.pinnedEnabled.checked = state.editOriginal.pinnedEnabled;
  form.pinnedUntil.value = state.editOriginal.pinnedUntil;
  form.featuredEnabled.checked = state.editOriginal.featuredEnabled;
  form.featuredUntil.value = state.editOriginal.featuredUntil;
  form.pinnedUntil.disabled = !form.pinnedEnabled.checked;
  form.featuredUntil.disabled = !form.featuredEnabled.checked;
  elements.editDialog.showModal();
}

async function submitEdit(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  const form = elements.editForm.elements;
  const next = {
    id: form.id.value,
    category: form.category.value,
    time: form.time.value,
    title: form.title.value,
    comment: form.comment.value,
    tags: form.tags.value,
    pinnedEnabled: form.pinnedEnabled.checked,
    pinnedUntil: form.pinnedUntil.value,
    featuredEnabled: form.featuredEnabled.checked,
    featuredUntil: form.featuredUntil.value,
  };

  if (state.editOriginal && JSON.stringify(next) === JSON.stringify(state.editOriginal)) {
    elements.editDialog.close();
    submit.disabled = false;
    showToast("没有检测到需要保存的修改");
    return;
  }

  try {
    await request(`/api/admin/gallery/${encodeURIComponent(form.id.value)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: next.category,
        time: fromLocalInput(next.time),
        title: next.title,
        comment: next.comment,
        tags: next.tags,
        pinnedEnabled: next.pinnedEnabled,
        pinnedUntil: fromLocalInput(next.pinnedUntil),
        featuredEnabled: next.featuredEnabled,
        featuredUntil: fromLocalInput(next.featuredUntil),
      }),
    });
    elements.editDialog.close();
    state.editOriginal = null;
    await loadGallery();
    showToast("修改已同步到图库索引");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function deleteCurrent() {
  const id = elements.editForm.elements.id.value;
  if (!confirm("确定删除这张图片吗？VPS 中的图片文件也会被删除，此操作无法撤销。")) return;
  elements.deleteButton.disabled = true;
  try {
    await request(`/api/admin/gallery/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.editDialog.close();
    await loadGallery();
    showToast("图片已从 VPS 存储和图库索引删除");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.deleteButton.disabled = false;
  }
}

function normalizeFormDates(form) {
  ["time", "pinnedUntil", "featuredUntil"].forEach((name) => {
    if (form.has(name)) form.set(name, fromLocalInput(form.get(name)));
  });
}

function setupFormAfterReset(form) {
  ["pinned", "featured"].forEach((name) => {
    form.elements[`${name}Until`].disabled = true;
  });
}

function setDefaultUploadTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  elements.uploadForm.elements.time.value = now.toISOString().slice(0, 19);
}

function fromLocalInput(value) {
  if (!value) return "";
  const text = String(value).replace("T", " ").slice(0, 19);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text) ? `${text}:00` : text;
}

function toLocalInput(value) {
  return value ? String(value).replace(" ", "T").slice(0, 19) : "";
}

function formatDisplayTime(value) {
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(bytes) {
  if (!bytes) return "未知大小";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.hidden = false;
  elements.toast.textContent = message;
  elements.toast.style.borderColor = error ? "rgba(255,133,143,.7)" : "#465064";
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}
