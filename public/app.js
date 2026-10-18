"use strict";

const CONFIG = Object.freeze({
  galleryApi: "/api/gallery",
  friendSessionApi: "/api/friend/session",
});
const GALLERY_BATCH_SIZE = 12;
const ABOVE_FOLD_IMAGES = 6;

const state = {
  categories: [],
  activeCategoryId: "",
  sortDirection: "desc",
  query: "",
  visibleImages: [],
  lightboxIndex: 0,
  heroImage: null,
  heroMode: "manual",
  friend: null,
  friendSessionExpiresAt: null,
  friendServiceAvailable: true,
  commentsByImage: new Map(),
  renderLimit: GALLERY_BATCH_SIZE,
};

const elements = {
  header: document.querySelector(".app-header"),
  headerMedia: document.querySelector("#header-media"),
  headerCover: document.querySelector("#header-cover"),
  friendEntry: document.querySelector("#friend-entry"),
  friendEntryLabel: document.querySelector("#friend-entry-label"),
  tabs: document.querySelector("#category-tabs"),
  grid: document.querySelector("#gallery-grid"),
  empty: document.querySelector("#empty-state"),
  summary: document.querySelector("#result-summary"),
  sortBadge: document.querySelector("#sort-badge"),
  sortSelect: document.querySelector("#sort-select"),
  searchInput: document.querySelector("#search-input"),
  galleryMore: document.querySelector("#gallery-more"),
  loadMore: document.querySelector("#load-more"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightbox-image"),
  lightboxPosition: document.querySelector("#lightbox-position"),
  lightboxTitle: document.querySelector("#lightbox-title"),
  lightboxTime: document.querySelector("#lightbox-time"),
  lightboxCategory: document.querySelector("#lightbox-category"),
  lightboxComment: document.querySelector("#lightbox-comment"),
  lightboxClose: document.querySelector("#lightbox-close"),
  lightboxPrev: document.querySelector("#lightbox-prev"),
  lightboxNext: document.querySelector("#lightbox-next"),
  lightboxStage: document.querySelector("#lightbox-stage"),
  openOriginal: document.querySelector("#open-original"),
  downloadOriginal: document.querySelector("#download-original"),
  imageLoader: document.querySelector("#image-loader"),
  commentsCount: document.querySelector("#comments-count"),
  commentsStatus: document.querySelector("#comments-status"),
  commentsList: document.querySelector("#comments-list"),
  commentsLogin: document.querySelector("#comments-login"),
  commentsGuest: document.querySelector("#comments-guest"),
  commentsGuestLogin: document.querySelector("#comments-guest-login"),
  commentForm: document.querySelector("#comment-form"),
  commentAs: document.querySelector("#comment-as"),
  friendDialog: document.querySelector("#friend-dialog"),
  friendDialogClose: document.querySelector("#friend-dialog-close"),
  friendLoginForm: document.querySelector("#friend-login-form"),
  friendSession: document.querySelector("#friend-session"),
  friendSessionName: document.querySelector("#friend-session-name"),
  friendLogout: document.querySelector("#friend-logout"),
  friendAuthMessage: document.querySelector("#friend-auth-message"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindControls();
  void loadFriendSession();

  let data;
  try {
    data = await requestJson(CONFIG.galleryApi);
  } catch (error) {
    console.error(error);
    showFatalError(error.message);
    return;
  }
  state.categories = normalizeGalleryData(data);
  if (!state.categories.length) {
    showFatalError("图库中没有分类");
    return;
  }
  state.heroMode = ["manual", "featured", "all"].includes(data.settings?.heroMode)
    ? data.settings.heroMode
    : "manual";
  state.heroImage = chooseHeroImage(data);
  state.activeCategoryId = state.categories[0].id;
  renderHeroImage();
  renderTabs();
  renderGallery();
  openLinkedPhoto();
}

async function loadFriendSession() {
  try {
    applyFriendSession(await requestJson(CONFIG.friendSessionApi, { cache: "no-store" }));
  } catch (error) {
    state.friendServiceAvailable = false;
    console.warn(error);
  }
  renderFriendState();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function normalizeHeroImage(image) {
  if (!image?.id || !image?.url) return null;
  return {
    id: String(image.id),
    url: String(image.url),
    previewUrl: String(image.previewUrl || image.url),
    title: image.title ? String(image.title) : "",
    categoryName: image.categoryName ? String(image.categoryName) : "",
  };
}

function chooseHeroImage(data) {
  if (state.heroMode === "manual") return normalizeHeroImage(data.heroImage);
  const unique = new Map();
  state.categories.forEach((category) => {
    category.images.forEach((image) => unique.set(image.id, image));
  });
  const allImages = [...unique.values()];
  const candidates = state.heroMode === "featured"
    ? allImages.filter((image) => image.featured)
    : allImages;
  const pool = candidates.length ? candidates : allImages;
  if (!pool.length) return normalizeHeroImage(data.heroImage);
  const image = pool[Math.floor(Math.random() * pool.length)];
  return normalizeHeroImage(image);
}

function renderHeroImage() {
  const image = state.heroImage;
  if (!image) {
    elements.headerMedia.hidden = true;
    elements.header.classList.remove("has-cover", "is-cover-ready");
    return;
  }

  let preload = document.querySelector("#hero-image-preload");
  if (!preload) {
    preload = document.createElement("link");
    preload.id = "hero-image-preload";
    preload.rel = "preload";
    preload.as = "image";
    document.head.append(preload);
  }
  preload.fetchPriority = "high";
  preload.href = image.previewUrl;

  elements.headerMedia.hidden = false;
  elements.header.classList.add("has-cover");
  elements.header.classList.remove("is-cover-ready");
  elements.headerCover.alt = image.title || `${image.categoryName || "冒险"}标题照片`;
  elements.headerCover.loading = "eager";
  elements.headerCover.fetchPriority = "high";
  elements.headerCover.onload = () => {
    elements.header.classList.add("is-cover-ready");
  };
  elements.headerCover.onerror = () => {
    elements.headerMedia.hidden = true;
    elements.header.classList.remove("has-cover", "is-cover-ready");
  };
  elements.headerCover.src = image.previewUrl;
}

function normalizeGalleryData(data) {
  if (!data || !Array.isArray(data.categories)) return [];

  return data.categories.map((category, categoryIndex) => ({
    id: String(category.id || `category-${categoryIndex + 1}`),
    name: String(category.name || "未命名分类"),
    virtual: Boolean(category.virtual),
    images: Array.isArray(category.images)
      ? category.images
          .filter((image) => image && image.id)
          .map((image) => ({
            id: String(image.id),
            time: String(image.time || "未知时间"),
            tags: Array.isArray(image.tags) ? image.tags.map(String) : [],
            title: image.title ? String(image.title) : "",
            comment: image.comment ? String(image.comment) : "",
            pinned: Boolean(image.pinned),
            featured: Boolean(image.featured),
            url: String(image.url || `/gallery/${encodeURIComponent(image.id)}`),
            thumbnailUrl: String(
              image.thumbnailUrl
              || `/gallery/${encodeURIComponent(image.id)}?variant=thumbnail`,
            ),
            previewUrl: String(
              image.previewUrl
              || `/gallery/${encodeURIComponent(image.id)}?variant=preview`,
            ),
            categoryId: String(image.categoryId || category.id || `category-${categoryIndex + 1}`),
            categoryName: String(image.categoryName || category.name || "未命名分类"),
            friendCommentCount: Number(image.friendCommentCount || 0),
            friendComments: normalizeComments(image.friendComments),
          }))
      : [],
  }));
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .filter((comment) => comment?.id)
    .map((comment) => ({
      id: String(comment.id),
      authorName: String(comment.authorName || "好友"),
      authorVerified: comment.authorVerified === true,
      content: String(comment.content || ""),
      createdAt: String(comment.createdAt || ""),
    }));
}

function parseTime(time) {
  const value = Date.parse(String(time).replace(" ", "T"));
  return Number.isNaN(value) ? 0 : value;
}

function formatTime(time) {
  const date = new Date(String(time).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return time;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatCommentTime(time) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function renderTabs() {
  elements.tabs.replaceChildren();
  state.categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-button";
    button.id = `tab-${category.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "gallery-grid");
    button.setAttribute("aria-selected", String(category.id === state.activeCategoryId));
    button.tabIndex = category.id === state.activeCategoryId ? 0 : -1;

    const label = document.createElement("span");
    label.className = "category-label";
    const name = document.createElement("strong");
    name.textContent = category.name;
    const count = document.createElement("span");
    count.textContent = `${category.images.length} 个瞬间`;
    label.append(name, count);
    button.append(label);
    button.addEventListener("click", () => selectCategory(category.id));
    button.addEventListener("keydown", handleTabKeys);
    elements.tabs.append(button);
  });
}

function selectCategory(categoryId) {
  if (state.activeCategoryId === categoryId) return;
  state.activeCategoryId = categoryId;
  state.renderLimit = GALLERY_BATCH_SIZE;
  renderTabs();
  renderGallery();
}

function handleTabKeys(event) {
  const vertical = matchMedia("(min-width: 561px)").matches;
  const previousKey = vertical ? "ArrowUp" : "ArrowLeft";
  const nextKey = vertical ? "ArrowDown" : "ArrowRight";
  if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
  event.preventDefault();

  const ids = state.categories.map((category) => category.id);
  const currentIndex = ids.indexOf(state.activeCategoryId);
  let nextIndex = currentIndex;
  if (event.key === previousKey) nextIndex = (currentIndex - 1 + ids.length) % ids.length;
  if (event.key === nextKey) nextIndex = (currentIndex + 1) % ids.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = ids.length - 1;
  selectCategory(ids[nextIndex]);
  document.querySelector(`#tab-${CSS.escape(ids[nextIndex])}`)?.focus();
}

function getVisibleImages() {
  const activeCategory = state.categories.find((category) => category.id === state.activeCategoryId);
  if (!activeCategory) return [];
  const normalizedQuery = state.query.trim().toLocaleLowerCase("zh-CN");
  const images = activeCategory.images.filter((image) => {
    if (!normalizedQuery) return true;
    const friendText = image.friendComments
      .flatMap((comment) => [comment.authorName, comment.content]);
    return [image.time, image.title, image.comment, image.categoryName, ...image.tags, ...friendText]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(normalizedQuery);
  });

  return images.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    const delta = parseTime(a.time) - parseTime(b.time);
    if (delta !== 0) return state.sortDirection === "asc" ? delta : -delta;
    return state.sortDirection === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  });
}

function renderGallery() {
  const activeCategory = state.categories.find((category) => category.id === state.activeCategoryId);
  if (!activeCategory) return;
  elements.grid.setAttribute("aria-busy", "false");
  state.visibleImages = getVisibleImages();
  elements.grid.replaceChildren();
  state.visibleImages
    .slice(0, state.renderLimit)
    .forEach((image, index) => elements.grid.append(createImageCard(image, index)));

  const count = state.visibleImages.length;
  const queryNote = state.query.trim() ? ` · 搜索“${state.query.trim()}”` : "";
  elements.summary.textContent = `${activeCategory.name} · ${count} 张影像${queryNote}`;
  elements.sortBadge.textContent = state.sortDirection === "desc" ? "时间倒序" : "时间正序";
  elements.empty.hidden = count !== 0;
  elements.grid.hidden = count === 0;
  updateLoadMoreState();
}

function updateLoadMoreState() {
  const remaining = Math.max(0, state.visibleImages.length - state.renderLimit);
  elements.galleryMore.hidden = remaining === 0;
  elements.loadMore.textContent = remaining > 0
    ? `继续加载（剩余 ${remaining} 张）`
    : "已加载全部";
}

function loadMoreImages() {
  const start = state.renderLimit;
  if (start >= state.visibleImages.length) return;
  state.renderLimit = Math.min(state.visibleImages.length, start + GALLERY_BATCH_SIZE);
  state.visibleImages
    .slice(start, state.renderLimit)
    .forEach((image, offset) =>
      elements.grid.append(createImageCard(image, start + offset)));
  updateLoadMoreState();
}

function createImageCard(image, index) {
  const article = document.createElement("article");
  article.className = "gallery-card";
  const imageButton = document.createElement("button");
  imageButton.type = "button";
  imageButton.className = "image-button";
  imageButton.setAttribute("aria-label", `查看大图：${image.title || formatTime(image.time)}`);
  imageButton.addEventListener("click", () => openLightbox(index));

  const picture = document.createElement("img");
  const aboveFold = index < ABOVE_FOLD_IMAGES;
  picture.alt = image.title || `${image.categoryName}截图，拍摄于${formatTime(image.time)}`;
  picture.loading = aboveFold ? "eager" : "lazy";
  picture.fetchPriority = aboveFold ? "auto" : "low";
  picture.decoding = "async";
  picture.dataset.loading = "true";
  picture.addEventListener("load", () => delete picture.dataset.loading);
  picture.addEventListener("error", () => {
    delete picture.dataset.loading;
    imageButton.classList.add("has-error");
  });
  picture.src = image.thumbnailUrl;

  const viewMark = document.createElement("span");
  viewMark.className = "view-mark";
  viewMark.setAttribute("aria-hidden", "true");
  viewMark.textContent = "↗";
  const badges = document.createElement("span");
  badges.className = "card-badges";
  if (image.pinned) badges.append(makeSpan("置顶"));
  if (image.featured) badges.append(makeSpan("精选"));
  const error = document.createElement("span");
  error.className = "image-error";
  error.textContent = "图片暂时无法加载";
  imageButton.append(picture, badges, viewMark, error);

  const body = document.createElement("div");
  body.className = "card-body";
  const category = document.createElement("span");
  category.className = "card-category";
  category.textContent = image.categoryName;
  const time = document.createElement("p");
  time.className = "card-time";
  time.textContent = formatTime(image.time);
  body.append(category, time);

  if (image.title) {
    const title = document.createElement("p");
    title.className = "card-file";
    title.textContent = image.title;
    body.append(title);
  }
  if (image.comment) {
    const comment = document.createElement("p");
    comment.className = "card-comment";
    comment.textContent = image.comment;
    body.append(comment);
  }
  if (image.tags.length) {
    const tags = document.createElement("div");
    tags.className = "tag-list";
    image.tags.forEach((tag) => tags.append(makeSpan(`# ${tag}`)));
    body.append(tags);
  }
  if (image.friendCommentCount > 0) {
    body.append(createCardComments(image, index));
  }
  article.append(imageButton, body);
  return article;
}

function createCardComments(image, index) {
  const section = document.createElement("section");
  section.className = "card-friend-comments";
  image.friendComments.slice(0, 2).forEach((comment) => {
    const line = document.createElement("p");
    const author = document.createElement("strong");
    author.textContent = `${comment.authorName} · ${comment.authorVerified ? "已认证" : "待认证"}：`;
    const content = document.createElement("span");
    content.textContent = comment.content;
    line.append(author, content);
    section.append(line);
  });
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = `查看 ${image.friendCommentCount} 条好友留言`;
  open.addEventListener("click", () => openLightbox(index));
  section.append(open);
  return section;
}

function makeSpan(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function bindControls() {
  elements.sortSelect.addEventListener("change", (event) => {
    state.sortDirection = event.target.value === "asc" ? "asc" : "desc";
    state.renderLimit = GALLERY_BATCH_SIZE;
    renderGallery();
  });
  let searchTimer = null;
  elements.searchInput.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const query = event.target.value;
    searchTimer = setTimeout(() => {
      state.query = query;
      state.renderLimit = GALLERY_BATCH_SIZE;
      renderGallery();
    }, 180);
  });
  elements.loadMore.addEventListener("click", loadMoreImages);
  if ("IntersectionObserver" in window) {
    const loadMoreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreImages();
    }, { rootMargin: "600px 0px" });
    loadMoreObserver.observe(elements.galleryMore);
  }
  elements.friendEntry.addEventListener("click", openFriendDialog);
  elements.friendDialogClose.addEventListener("click", () => elements.friendDialog.close());
  elements.friendLoginForm.addEventListener("submit", submitFriendLogin);
  elements.friendLogout.addEventListener("click", logoutFriend);
  elements.commentsLogin.addEventListener("click", openFriendDialog);
  elements.commentsGuestLogin.addEventListener("click", openFriendDialog);
  elements.commentForm.addEventListener("submit", submitComment);

  elements.lightboxClose.addEventListener("click", closeLightbox);
  elements.lightboxPrev.addEventListener("click", () => moveLightbox(-1));
  elements.lightboxNext.addEventListener("click", () => moveLightbox(1));
  elements.lightbox.addEventListener("click", (event) => {
    if (event.target === elements.lightbox) closeLightbox();
  });
  elements.lightbox.addEventListener("keydown", handleLightboxKeys);
  elements.lightbox.addEventListener("close", () => {
    elements.lightboxImage.src = "";
    document.body.style.overflow = "";
  });

  let touchStartX = null;
  elements.lightboxStage.addEventListener("touchstart", (event) => {
    touchStartX = event.target.closest(".comments-panel")
      ? null
      : event.changedTouches[0].clientX;
  }, { passive: true });
  elements.lightboxStage.addEventListener("touchend", (event) => {
    if (touchStartX === null) return;
    const distance = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(distance) > 55) moveLightbox(distance > 0 ? -1 : 1);
    touchStartX = null;
  }, { passive: true });
}

function openLightbox(index) {
  state.lightboxIndex = index;
  updateLightbox();
  if (!elements.lightbox.open) elements.lightbox.showModal();
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  if (elements.lightbox.open) elements.lightbox.close();
}

function moveLightbox(direction) {
  const nextIndex = state.lightboxIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.visibleImages.length) return;
  state.lightboxIndex = nextIndex;
  updateLightbox();
}

function updateLightbox() {
  const image = state.visibleImages[state.lightboxIndex];
  if (!image) return;
  elements.commentForm.reset();
  elements.lightboxPosition.textContent = `${state.lightboxIndex + 1} / ${state.visibleImages.length}`;
  elements.lightboxTitle.textContent = image.title || "冒险瞬间";
  elements.lightboxTime.textContent = formatTime(image.time);
  elements.lightboxCategory.textContent = image.categoryName;
  elements.lightboxComment.textContent = image.comment;
  elements.lightboxComment.hidden = !image.comment;
  elements.openOriginal.href = image.url;
  elements.downloadOriginal.href = `${image.url}?download=1`;
  elements.downloadOriginal.download = `${image.time.replace(/[: ]/g, "-")}-${image.id}`;
  elements.lightboxPrev.disabled = state.lightboxIndex === 0;
  elements.lightboxNext.disabled = state.lightboxIndex === state.visibleImages.length - 1;
  elements.lightboxImage.alt = image.title || `${image.categoryName}大图`;
  elements.lightboxImage.classList.add("is-loading");
  elements.imageLoader.classList.add("is-visible");
  elements.lightboxImage.onload = () => {
    elements.lightboxImage.classList.remove("is-loading");
    elements.imageLoader.classList.remove("is-visible");
  };
  elements.lightboxImage.onerror = () => {
    elements.lightboxImage.classList.remove("is-loading");
    elements.imageLoader.classList.remove("is-visible");
  };
  elements.lightboxImage.src = image.previewUrl;
  loadComments(image);
}

function handleLightboxKeys(event) {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
}

function initialCommentRecord(image) {
  return {
    total: image.friendCommentCount,
    comments: image.friendComments,
    error: "",
  };
}

async function loadComments(image) {
  if (!state.commentsByImage.has(image.id)) {
    state.commentsByImage.set(image.id, initialCommentRecord(image));
  }
  const record = state.commentsByImage.get(image.id);
  record.error = "";
  renderComments(image.id);
  try {
    const data = await requestJson(`/api/comments/${encodeURIComponent(image.id)}`, {
      cache: "no-store",
    });
    state.commentsByImage.set(image.id, {
      total: Number(data.total || 0),
      comments: normalizeComments(data.comments),
      error: "",
    });
    syncImageCommentSummaries(image.id);
  } catch (error) {
    record.error = error.message;
  }
  renderComments(image.id);
}

function renderComments(imageId) {
  const current = state.visibleImages[state.lightboxIndex];
  if (!current || current.id !== imageId) return;
  const record = state.commentsByImage.get(imageId) || initialCommentRecord(current);
  elements.commentsCount.textContent = `${record.total} 条`;
  elements.commentsList.replaceChildren();
  record.comments.forEach((comment) => {
    const article = document.createElement("article");
    const header = document.createElement("div");
    const author = document.createElement("strong");
    author.textContent = `${comment.authorName} · ${comment.authorVerified ? "已认证" : "待认证"}`;
    const time = document.createElement("time");
    time.dateTime = comment.createdAt;
    time.textContent = formatCommentTime(comment.createdAt);
    const content = document.createElement("p");
    content.textContent = comment.content;
    header.append(author, time);
    article.append(header, content);
    elements.commentsList.append(article);
  });
  if (!record.comments.length && !record.error) {
    const empty = document.createElement("p");
    empty.className = "comments-empty";
    empty.textContent = "还没有留言，来写下第一张小纸条吧。";
    elements.commentsList.append(empty);
  }
  elements.commentsStatus.textContent = record.error;
  elements.commentsStatus.classList.toggle("is-error", Boolean(record.error));
  renderFriendState();
}

function applyFriendSession(data) {
  state.friend = data.authenticated && data.friend
    ? { id: String(data.friend.id), displayName: String(data.friend.displayName), verified: data.friend.verified === true }
    : null;
  state.friendSessionExpiresAt = data.expiresAt || null;
  state.friendServiceAvailable = true;
}

function renderFriendState() {
  const loggedIn = Boolean(state.friend);
  elements.friendEntryLabel.textContent = loggedIn
    ? `${state.friend.displayName} · ${state.friend.verified ? "已认证" : "待认证"}`
    : "好友登录";
  elements.friendEntry.classList.toggle("is-logged-in", loggedIn);
  elements.friendLoginForm.hidden = loggedIn;
  elements.friendSession.hidden = !loggedIn;
  elements.friendSessionName.textContent = loggedIn ? `你好，${state.friend.displayName} · ${state.friend.verified ? "已认证" : "待认证"}` : "";
  elements.commentForm.hidden = !loggedIn;
  elements.commentsGuest.hidden = loggedIn;
  elements.commentsLogin.textContent = loggedIn ? `${state.friend.displayName} · ${state.friend.verified ? "已认证" : "待认证"}` : "好友登录";
  elements.commentAs.textContent = loggedIn ? `以 ${state.friend.displayName} 的身份留言（${state.friend.verified ? "已认证" : "待后台认证，可正常留言"}）` : "";
  if (!state.friendServiceAvailable && !loggedIn) {
    elements.commentsGuest.querySelector("p").textContent = "好友登录服务暂时不可用。";
  }
}

function openFriendDialog() {
  elements.friendAuthMessage.textContent = "";
  renderFriendState();
  if (!elements.friendDialog.open) elements.friendDialog.showModal();
  if (!state.friend) elements.friendLoginForm.elements.displayName.focus();
}

async function submitFriendLogin(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  elements.friendAuthMessage.textContent = "正在登录留言身份…";
  elements.friendAuthMessage.classList.remove("is-error");
  try {
    const data = await requestJson(CONFIG.friendSessionApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: elements.friendLoginForm.elements.displayName.value,
        studentId: elements.friendLoginForm.elements.studentId.value,
      }),
    });
    applyFriendSession(data);
    elements.friendLoginForm.reset();
    renderFriendState();
    elements.friendDialog.close();
    if (elements.lightbox.open) elements.commentForm.elements.content.focus();
  } catch (error) {
    elements.friendAuthMessage.textContent = error.message;
    elements.friendAuthMessage.classList.add("is-error");
  } finally {
    submit.disabled = false;
  }
}

async function logoutFriend() {
  elements.friendLogout.disabled = true;
  try {
    const data = await requestJson(CONFIG.friendSessionApi, { method: "DELETE" });
    applyFriendSession(data);
    renderFriendState();
    elements.friendDialog.close();
  } catch (error) {
    elements.friendAuthMessage.textContent = error.message;
    elements.friendAuthMessage.classList.add("is-error");
  } finally {
    elements.friendLogout.disabled = false;
  }
}

async function submitComment(event) {
  event.preventDefault();
  const image = state.visibleImages[state.lightboxIndex];
  if (!image || !state.friend) return;
  const submit = event.submitter;
  const content = elements.commentForm.elements.content.value.trim();
  if (!content) return;
  submit.disabled = true;
  elements.commentsStatus.textContent = "正在放好小纸条…";
  elements.commentsStatus.classList.remove("is-error");
  try {
    const data = await requestJson(`/api/comments/${encodeURIComponent(image.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const record = state.commentsByImage.get(image.id) || initialCommentRecord(image);
    record.comments = [data.comment, ...record.comments.filter((item) => item.id !== data.comment.id)];
    record.total += 1;
    record.error = "";
    state.commentsByImage.set(image.id, record);
    elements.commentForm.reset();
    syncImageCommentSummaries(image.id);
    const activeImageId = image.id;
    renderGallery();
    state.lightboxIndex = Math.max(0, state.visibleImages.findIndex((item) => item.id === activeImageId));
    renderComments(activeImageId);
    elements.commentsStatus.textContent = "留言已经发表啦。";
  } catch (error) {
    elements.commentsStatus.textContent = error.message;
    elements.commentsStatus.classList.add("is-error");
    if (error.message.includes("登录")) {
      state.friend = null;
      renderFriendState();
    }
  } finally {
    submit.disabled = false;
  }
}

function syncImageCommentSummaries(imageId) {
  const record = state.commentsByImage.get(imageId);
  if (!record) return;
  state.categories.forEach((category) => {
    category.images.forEach((image) => {
      if (image.id !== imageId) return;
      image.friendCommentCount = record.total;
      image.friendComments = record.comments.slice(0, 2);
    });
  });
}

function openLinkedPhoto() {
  const imageId = new URL(location.href).searchParams.get("photo");
  if (!imageId) return;
  const category = state.categories.find((item) => !item.virtual
    && item.images.some((image) => image.id === imageId))
    || state.categories.find((item) => item.images.some((image) => image.id === imageId));
  if (!category) return;
  state.activeCategoryId = category.id;
  state.renderLimit = GALLERY_BATCH_SIZE;
  renderTabs();
  renderGallery();
  const index = state.visibleImages.findIndex((image) => image.id === imageId);
  if (index >= state.renderLimit) {
    state.renderLimit = Math.ceil((index + 1) / GALLERY_BATCH_SIZE) * GALLERY_BATCH_SIZE;
    renderGallery();
  }
  if (index >= 0) openLightbox(index);
}

function showFatalError(message) {
  elements.grid.hidden = true;
  elements.empty.hidden = false;
  elements.empty.querySelector("h3").textContent = "图库读取失败";
  elements.empty.querySelector("p").textContent = message;
  elements.summary.textContent = "无法连接图库服务";
}
