/**
 * script.js - Telegram聊天记录通用美化脚本
 * 功能：灯箱媒体查看器、日期导航、标签导航、Open Graph链接预览、
 *       图片缩放拖拽、视频快进快退、消息合并、日期格式转换等
 * 使用：替换Telegram导出HTML中的同名文件即可
 */

// ==================== 全局变量 ====================

// 灯箱媒体相关
let mediaItems = [];          // 所有媒体项（按DOM顺序混合图片和视频）
let filteredMediaItems = [];  // 筛选后的媒体列表
let currentIndex = 0;         // 当前显示的媒体索引
let mediaFilterMode = 'all';  // 媒体筛选模式：'all' | 'image' | 'video'
let isMediaSwitching = false; // 媒体切换动画中标志（禁止关闭灯箱）
let userZoomTransition = false; // 用户双击缩放动画保护标志
let isVideoFullscreen = false;   // 视频是否全屏状态（隔离网页操作）
let lightboxOpenTime = 0;        // 灯箱打开时间戳（防止移动端双击误触立即关闭）

// 标签导航相关
let categoriesData = {};      // 所有标签数据（key为标签名，value含消息列表）
let currentCategory = null;   // 当前选中的标签名

// 媒体尺寸缓存（用于滑动预览精确匹配灯箱显示尺寸）
const mediaSizeCache = {};

/** 预加载指定媒体的尺寸信息到缓存，返回Promise */
function preloadMediaSize(mediaItem) {
    if (!mediaItem) return Promise.resolve();
    if (mediaSizeCache[mediaItem.src]) return Promise.resolve();
    return new Promise(function(resolve) {
        if (mediaItem.type === 'image') {
            const img = new Image();
            img.onload = function() {
                mediaSizeCache[mediaItem.src] = { width: img.naturalWidth, height: img.naturalHeight };
                resolve();
            };
            img.onerror = resolve;
            img.src = mediaItem.src;
        } else if (mediaItem.type === 'video') {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = function() {
                mediaSizeCache[mediaItem.src] = { width: video.videoWidth, height: video.videoHeight };
                resolve();
            };
            video.onerror = resolve;
            // 3秒超时，避免网络慢时阻塞
            setTimeout(resolve, 3000);
            video.src = mediaItem.src;
        } else {
            resolve();
        }
    });
}

/** 预加载当前媒体前后各2个媒体的尺寸 */
function preloadAdjacentMediaSizes() {
    for (let i = -2; i <= 2; i++) {
        const idx = currentIndex + i;
        if (idx >= 0 && idx < filteredMediaItems.length) {
            preloadMediaSize(filteredMediaItems[idx]);
        }
    }
}

/** 获取灯箱可用视口尺寸（与CSS vw/vh一致，不受移动端地址栏影响） */
function getLightboxViewport() {
    return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
    };
}

/** 计算媒体在灯箱中的实际显示尺寸（与CSS max-width/max-height完全一致） */
function calcMediaDisplaySize(mediaItem) {
    const cached = mediaSizeCache[mediaItem.src];
    if (!cached) return null;
    const vp = getLightboxViewport();
    // 移动端CSS: max-width:96vw;max-height:88vh  PC端CSS: max-width:95vw;max-height:95vh
    const mobile = isMobileDevice();
    const maxW = vp.width * (mobile ? 0.96 : 0.95);
    const maxH = vp.height * (mobile ? 0.88 : 0.95);
    const ratio = Math.min(maxW / cached.width, maxH / cached.height, 1);
    return { width: Math.round(cached.width * ratio), height: Math.round(cached.height * ratio) };
}

// ==================== 初始化入口 ====================

/** 页面加载完成后按顺序初始化所有功能 */
document.addEventListener('DOMContentLoaded', function () {
    // 创建加载遮罩（隐藏初始化过程中的样式变化）
    const loadingStartTime = Date.now();
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'page-loading-overlay';
    loadingOverlay.innerHTML = `
        <div class="loading-logo">
            <svg viewBox="0 0 240 240"><defs><linearGradient id="tg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6CB5F9"/><stop offset="100%" stop-color="#3E99ED"/></linearGradient></defs><circle cx="120" cy="120" r="120" fill="url(#tg)"/><path d="M98 175c-3.9 0-3.2-1.5-4.6-5.2L82 135.8l95-56.8" fill="#C8DAEA"/><path d="M98 175c3 0 4.3-1.4 6-3l16-15.6-20-12" fill="#A9C9DD"/><path d="M100 144.4l48.4 35.7c5.5 3 9.5 1.5 10.9-5.1l19.7-92.8c2-8.1-3.1-11.7-8.4-9.3l-115.5 44.5c-7.9 3.2-7.8 7.6-1.4 9.6l29.6 9.2 68.6-43.3c3.2-2 6.2-.9 3.8 1.3" fill="white"/></svg>
        </div>
        <div class="loading-progress-track"><div class="loading-progress-bar"></div></div>
        <div class="loading-text">加载中</div>
    `;
    document.body.appendChild(loadingOverlay);

    // 第一步：自动创建灯箱容器（如果不存在）
    createLightboxIfNeeded();

    // 第二步：自动为标题添加背景装饰
    addHeaderBgDots();

    // 第三步：转换日期格式
    convertDates();

    // 第四步：重新组织消息，将joined消息合并到主消息中
    reorganizeMessages();

    // 第五步：收集所有图片和视频
    collectMedia();

    // 第六步：创建日期导航
    createDateNavigation();

    // 第七步：创建分类导航
    createCategoryNavigation();

    // 第八步：初始化链接预览
    initLinkPreviews();

    // 第九步：美化分页链接
    beautifyPagination();

    // 第十步：替换网页标题
    updatePageTitle();

    // 第十一步：添加网页图标
    addFavicon();

    // 第十二步：创建滚动至顶部/底部按钮
    createScrollButtons();

    // 最后：标记页面初始化完成，等待最低1秒后淡出遮罩再显示内容
    const elapsed = Date.now() - loadingStartTime;
    const minDisplayTime = 1000;
    const remainingTime = Math.max(0, minDisplayTime - elapsed);

    setTimeout(() => {
        // 先让page_wrap可见（但被遮罩盖住，用户看不到）
        document.body.classList.add('page-ready');
        // 强制重排确保page_wrap已渲染完毕
        void document.body.offsetHeight;
        // 淡出遮罩
        requestAnimationFrame(() => {
            loadingOverlay.classList.add('fade-out');
            // 淡出动画结束后移除遮罩DOM
            setTimeout(() => {
                if (loadingOverlay.parentNode) {
                    loadingOverlay.parentNode.removeChild(loadingOverlay);
                }
            }, 600);
        });
    }, remainingTime);
});

// ==================== 灯箱模块 ====================

/**
 * 自动创建灯箱容器
 * 包含：内容区、关闭/上一个/下一个按钮、计数器、媒体筛选栏
 * 同时绑定：背景点击关闭、触摸滑动切换、视频悬停检测
 */
function createLightboxIfNeeded() {
    // 检查是否已经存在灯箱容器
    if (document.getElementById('lightbox')) {
        return; // 已存在，不再创建
    }

    // 创建灯箱容器
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.id = 'lightbox';
    lightbox.innerHTML = `
        <div class="lightbox-content" id="lightbox-content"></div>
        <button class="lightbox-close" onclick="closeLightbox()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        <button class="lightbox-prev" onclick="changeMedia(-1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button class="lightbox-next" onclick="changeMedia(1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <div class="lightbox-counter" id="lightbox-counter"></div>
        <div class="lightbox-filter" id="lightbox-filter"></div>
    `;

    // 插入到body的最前面
    document.body.insertBefore(lightbox, document.body.firstChild);

    // 绑定点击背景关闭事件（仅PC端；移动端由touchend坐标判断处理，避免touch穿透误关闭）
    lightbox.addEventListener('click', function (e) {
        if (isMobileDevice()) return;
        if (e.target === lightbox) {
            closeLightbox();
        }
    });

    // 阻止内容区域点击冒泡
    const content = document.getElementById('lightbox-content');
    if (content) {
        content.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }

    // 移动端触摸支持：双指缩放 + 单指拖拽/滑动切换 + 双击放大/缩小
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let lastPinchDist = 0;
    let isTouchDragging = false;
    let touchDragStartX = 0;
    let touchDragStartY = 0;
    let touchDragLastX = 0;
    let touchDragLastY = 0;
    let touchMoved = false;
    let lastTapTime = 0;        // 上次tap时间（用于双击检测）
    let touchOnButton = false;  // 本次触摸是否在按钮上

    // 移动端滑动切换相关
    let isSwiping = false;          // 是否正在进行水平滑动切换
    let swipeContainer = null;      // 滑动容器DOM
    let swipeCurrentX = 0;          // 当前滑动偏移量
    let swipeDirection = 0;         // 滑动方向锁定：0=未锁定, 1=水平, 2=垂直

    /** 创建滑动预览元素：图片优先用已缓存的原图，否则用缩略图；视频必须有缓存尺寸才显示预览图；滑动过程中不显示loading */
    function createSlidePreview(mediaItem) {
        if (!mediaItem) return null;
        const displaySize = calcMediaDisplaySize(mediaItem);

        // 获取缩略图src
        const domThumb = mediaItem.element ? mediaItem.element.querySelector('img') : null;
        const thumbSrc = mediaItem.thumb || (domThumb ? domThumb.src : '');

        // 视频类型：必须有缓存尺寸才显示预览图，否则返回空占位（避免缩略图尺寸与视频实际尺寸不一致）
        if (mediaItem.type === 'video') {
            if (!displaySize) {
                const placeholder = document.createElement('div');
                placeholder.style.cssText = 'position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center;';
                return placeholder;
            }
            // 有缓存尺寸的视频：用缩略图填满精确容器
            const container = document.createElement('div');
            container.style.cssText = `position:relative;width:${displaySize.width}px;height:${displaySize.height}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1);overflow:hidden;`;
            if (thumbSrc) {
                const img = document.createElement('img');
                img.src = thumbSrc;
                img.style.cssText = `width:100%;height:100%;object-fit:cover;transition:none;pointer-events:none;border-radius:0;`;
                container.appendChild(img);
            }
            return container;
        }

        // 图片类型：检查原图是否已在浏览器缓存中
        let bestSrc = thumbSrc;
        if (mediaItem.src) {
            const probe = new Image();
            probe.src = mediaItem.src;
            if (probe.complete && probe.naturalWidth > 0) {
                bestSrc = mediaItem.src;
            } else if (!bestSrc) {
                bestSrc = mediaItem.src;
            }
        }

        // 无尺寸且无图片源：返回空占位
        if (!displaySize && !bestSrc) {
            const placeholder = document.createElement('div');
            placeholder.style.cssText = 'position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center;';
            return placeholder;
        }

        // 无缓存尺寸但有图片源：用图片显示，尺寸按视口限制
        if (!displaySize) {
            const container = document.createElement('div');
            container.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;';
            const img = document.createElement('img');
            img.src = bestSrc;
            img.style.cssText = 'max-width:96vw;max-height:88vh;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1);object-fit:contain;transition:none;pointer-events:none;';
            container.appendChild(img);
            return container;
        }

        // 有缓存尺寸：精确宽高的预览图
        const container = document.createElement('div');
        container.style.cssText = `position:relative;width:${displaySize.width}px;height:${displaySize.height}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;`;

        if (bestSrc) {
            const img = document.createElement('img');
            img.src = bestSrc;
            img.style.cssText = `width:${displaySize.width}px;height:${displaySize.height}px;object-fit:contain;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1);transition:none;pointer-events:none;`;
            container.appendChild(img);
        }
        return container;
    }

    /** 创建滑动切换容器：当前媒体 + 左右相邻媒体预览 */
    function createSwipeContainer() {
        const contentEl = document.getElementById('lightbox-content');
        if (!contentEl || !isMobileDevice() || currentScale > 1) return null;

        const vw = window.innerWidth;
        const container = document.createElement('div');
        container.className = 'swipe-container';
        container.style.cssText = `position:absolute;top:0;left:0;width:${vw * 3}px;height:100%;display:flex;align-items:center;transform:translateX(-${vw}px);will-change:transform;pointer-events:none;`;

        // 左侧（上一个媒体）
        const prevIdx = currentIndex - 1;
        const prevMedia = prevIdx >= 0 ? filteredMediaItems[prevIdx] : null;
        const prevSlide = document.createElement('div');
        prevSlide.style.cssText = `width:${vw}px;height:100%;display:flex;align-items:center;justify-content:center;flex-shrink:0;`;
        const prevEl = createSlidePreview(prevMedia);
        if (prevEl) prevSlide.appendChild(prevEl);
        container.appendChild(prevSlide);

        // 中间（当前媒体占位，实际内容由lightbox-content显示）
        const currentSlide = document.createElement('div');
        currentSlide.style.cssText = `width:${vw}px;height:100%;flex-shrink:0;`;
        container.appendChild(currentSlide);

        // 右侧（下一个媒体）
        const nextIdx = currentIndex + 1;
        const nextMedia = nextIdx < filteredMediaItems.length ? filteredMediaItems[nextIdx] : null;
        const nextSlide = document.createElement('div');
        nextSlide.style.cssText = `width:${vw}px;height:100%;display:flex;align-items:center;justify-content:center;flex-shrink:0;`;
        const nextEl = createSlidePreview(nextMedia);
        if (nextEl) nextSlide.appendChild(nextEl);
        container.appendChild(nextSlide);

        contentEl.appendChild(container);
        return container;
    }

    /** 清理滑动容器 */
    function removeSwipeContainer() {
        if (swipeContainer) {
            swipeContainer.remove();
            swipeContainer = null;
        }
        isSwiping = false;
        swipeCurrentX = 0;
        swipeDirection = 0;
    }

    /** 检测触摸目标是否为灯箱控制按钮（含视频播放按钮） */
    function isTouchOnControl(target) {
        if (!target) return false;
        return target.closest('.lightbox-close') ||
            target.closest('.lightbox-prev') ||
            target.closest('.lightbox-next') ||
            target.closest('.lightbox-filter') ||
            target.closest('.lightbox-filter-btn') ||
            target.closest('.video-play-btn');
    }

    /** 根据缩放状态控制移动端灯箱UI显隐 */
    function updateMobileLightboxUI() {
        if (!isMobileDevice()) return;
        const lb = document.getElementById('lightbox');
        if (!lb) return;
        const controls = lb.querySelectorAll('.lightbox-close, .lightbox-filter, .lightbox-counter');
        if (currentScale > 1) {
            // 放大状态：隐藏所有UI
            controls.forEach(el => { el.style.opacity = '0'; el.style.pointerEvents = 'none'; });
        } else {
            // 默认状态：显示筛选项和关闭按钮
            controls.forEach(el => { el.style.opacity = ''; el.style.pointerEvents = ''; });
        }
    }

    lightbox.addEventListener('touchstart', function (e) {
        // 切换动画中或视频全屏时不处理触摸事件
        if (isMediaSwitching || isVideoFullscreen) return;
        const touches = e.touches;
        touchMoved = false;
        touchStartTime = Date.now();

        // 检测是否点击在按钮上，如果是则不处理缩放/拖拽逻辑
        touchOnButton = isTouchOnControl(e.target);
        if (touchOnButton) return;

        if (touches.length === 2) {
            // 双指：记录初始距离，用于缩放
            e.preventDefault();
            lastPinchDist = Math.hypot(
                touches[0].clientX - touches[1].clientX,
                touches[0].clientY - touches[1].clientY
            );
        } else if (touches.length === 1) {
            touchStartX = touches[0].clientX;
            touchStartY = touches[0].clientY;

            // 重置滑动方向锁定
            swipeDirection = 0;
            removeSwipeContainer();

            // 放大状态下启用单指拖拽
            if (currentScale > 1 && currentImage) {
                isTouchDragging = true;
                touchDragStartX = touches[0].clientX;
                touchDragStartY = touches[0].clientY;
                touchDragLastX = translateX;
                touchDragLastY = translateY;
                currentImage.style.transition = 'none';
                e.preventDefault();
            }
        }
    }, { passive: false });

    lightbox.addEventListener('touchmove', function (e) {
        if (isMediaSwitching || isVideoFullscreen) return;
        if (touchOnButton) return;
        const touches = e.touches;

        if (touches.length === 2 && currentImage) {
            // 双指缩放
            e.preventDefault();
            const dist = Math.hypot(
                touches[0].clientX - touches[1].clientX,
                touches[0].clientY - touches[1].clientY
            );

            if (lastPinchDist > 0) {
                const scaleFactor = dist / lastPinchDist;
                const oldScale = currentScale;
                const newScale = Math.max(0.5, Math.min(5, currentScale * scaleFactor));

                // 以双指中心为缩放原点
                const centerX = (touches[0].clientX + touches[1].clientX) / 2;
                const centerY = (touches[0].clientY + touches[1].clientY) / 2;
                const rect = currentImage.getBoundingClientRect();
                const imgCenterX = rect.left + rect.width / 2;
                const imgCenterY = rect.top + rect.height / 2;
                const offsetX = centerX - imgCenterX;
                const offsetY = centerY - imgCenterY;
                const scaleRatio = newScale / oldScale;

                translateX = translateX + offsetX - offsetX * scaleRatio;
                translateY = translateY + offsetY - offsetY * scaleRatio;
                currentScale = newScale;

                updateImageTransform(currentImage);

                if (currentScale > 1) {
                    currentImage.classList.add('zoomed');
                } else {
                    currentImage.classList.remove('zoomed');
                }
                updateMobileLightboxUI();
            }
            lastPinchDist = dist;
            touchMoved = true;
        } else if (touches.length === 1 && isTouchDragging && currentImage) {
            // 单指拖拽（放大状态）
            e.preventDefault();
            const dx = touches[0].clientX - touchDragStartX;
            const dy = touches[0].clientY - touchDragStartY;
            translateX = touchDragLastX + dx;
            translateY = touchDragLastY + dy;
            updateImageTransform(currentImage);
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) touchMoved = true;
        } else if (touches.length === 1 && currentScale <= 1) {
            // 未放大状态：跟手滑动切换媒体
            const dx = touches[0].clientX - touchStartX;
            const dy = touches[0].clientY - touchStartY;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);

            if (absDx > 10 || absDy > 10) touchMoved = true;

            // 方向锁定：首次移动超过阈值时锁定方向
            if (swipeDirection === 0 && (absDx > 8 || absDy > 8)) {
                swipeDirection = absDx > absDy ? 1 : 2; // 1=水平, 2=垂直
            }

            // 水平滑动：跟手移动
            if (swipeDirection === 1 && isMobileDevice()) {
                e.preventDefault();
                // 检查是否有可切换的媒体
                const canSwipeLeft = dx > 0 && currentIndex > 0;
                const canSwipeRight = dx < 0 && currentIndex < filteredMediaItems.length - 1;

                if (canSwipeLeft || canSwipeRight) {
                    // 延迟创建滑动容器（首次进入跟手状态时创建）
                    if (!swipeContainer) {
                        swipeContainer = createSwipeContainer();
                        isSwiping = true;
                    }

                    if (swipeContainer) {
                        const vw = window.innerWidth;
                        swipeCurrentX = dx;
                        // 添加阻尼：边界处滑动距离减半
                        let offset = dx;
                        if (!canSwipeLeft && dx > 0) offset = dx * 0.3;
                        if (!canSwipeRight && dx < 0) offset = dx * 0.3;

                        swipeContainer.style.transition = 'none';
                        swipeContainer.style.transform = `translateX(${-vw + offset}px)`;

                        // 同步移动当前媒体内容（移动wrapper以确保播放按钮跟手）
                        const moveTarget = content.querySelector('.video-preview-wrapper') || currentImage;
                        if (moveTarget) {
                            moveTarget.style.transition = 'none';
                            moveTarget.style.transform = `translateX(${offset}px)`;
                        }
                        // 同步移动当前媒体的loading（跟着图片走）
                        const loadingEl = content.querySelector('.lightbox-loading');
                        if (loadingEl) {
                            loadingEl.style.transition = 'none';
                            loadingEl.style.transform = `translate(calc(-50% + ${offset}px), -50%)`;
                        }
                    }
                } else {
                    // 边界阻尼
                    if (!swipeContainer) {
                        swipeContainer = createSwipeContainer();
                        isSwiping = true;
                    }
                    if (swipeContainer) {
                        const vw = window.innerWidth;
                        const dampedDx = dx * 0.3;
                        swipeCurrentX = dx;
                        swipeContainer.style.transition = 'none';
                        swipeContainer.style.transform = `translateX(${-vw + dampedDx}px)`;
                        const moveTarget = content.querySelector('.video-preview-wrapper') || currentImage;
                        if (moveTarget) {
                            moveTarget.style.transition = 'none';
                            moveTarget.style.transform = `translateX(${dampedDx}px)`;
                        }
                        const loadingEl = content.querySelector('.lightbox-loading');
                        if (loadingEl) {
                            loadingEl.style.transition = 'none';
                            loadingEl.style.transform = `translate(calc(-50% + ${dampedDx}px), -50%)`;
                        }
                    }
                }
            }
        }
    }, { passive: false });

    lightbox.addEventListener('touchend', function (e) {
        // 切换动画中或视频全屏时不处理触摸结束
        if (isMediaSwitching || isVideoFullscreen) return;
        // 如果触摸在按钮上，让按钮自己的click事件处理，不做任何额外操作
        if (touchOnButton) {
            touchOnButton = false;
            return;
        }

        const touchDuration = Date.now() - touchStartTime;

        if (isTouchDragging) {
            isTouchDragging = false;
            if (currentImage) {
                currentImage.style.transition = 'none';
            }
        }

        // 双指缩放结束后，如果缩放比例接近1则平滑重置
        if (lastPinchDist > 0) {
            lastPinchDist = 0;
            if (currentScale < 1.05 && currentScale > 0.95 && currentImage) {
                currentImage.style.transition = 'transform 0.2s ease-out';
                currentScale = 1;
                translateX = 0;
                translateY = 0;
                updateImageTransform(currentImage);
                currentImage.classList.remove('zoomed');
                updateMobileLightboxUI();
                setTimeout(() => { if (currentImage) currentImage.style.transition = 'none'; }, 220);
            }
            return;
        }

        if (e.changedTouches.length !== 1) return;

        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const swipeX = endX - touchStartX;
        const swipeY = endY - touchStartY;
        const isTap = touchDuration < 300 && !touchMoved;
        const now = Date.now();
        const isDoubleTap = isTap && (now - lastTapTime < 350);

        if (currentScale <= 1) {
            // 未放大状态
            // 跟手滑动切换媒体（有滑动容器时）
            if (isSwiping && swipeContainer) {
                lastTapTime = 0;
                const vw = window.innerWidth;
                const velocity = Math.abs(swipeX) / Math.max(touchDuration, 1) * 1000; // px/s
                const threshold = vw * 0.25; // 滑动超过25%屏幕宽度即切换
                const fastSwipe = velocity > 500 && Math.abs(swipeX) > 30; // 快速滑动

                const shouldSwitch = Math.abs(swipeX) > threshold || fastSwipe;
                const direction = swipeX > 0 ? -1 : 1; // 右滑=上一个(-1), 左滑=下一个(1)
                const canSwitch = direction === -1 ? currentIndex > 0 : currentIndex < filteredMediaItems.length - 1;

                // 获取要移动的目标元素（wrapper或媒体元素，确保播放按钮跟手）
                const contentEl = document.getElementById('lightbox-content');
                const moveTarget = contentEl.querySelector('.video-preview-wrapper') || currentImage;

                if (shouldSwitch && canSwitch) {
                    // 切换锁定：防止切换动画中关闭灯箱或重复切换
                    isMediaSwitching = true;
                    // 切换：滑动到目标位置
                    const targetOffset = direction === 1 ? -vw : vw;
                    swipeContainer.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                    swipeContainer.style.transform = `translateX(${-vw + targetOffset}px)`;
                    if (moveTarget) {
                        moveTarget.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                        moveTarget.style.transform = `translateX(${targetOffset}px)`;
                    }
                    // loading也跟着滑动
                    const switchLoadingEl = contentEl.querySelector('.lightbox-loading');
                    if (switchLoadingEl) {
                        switchLoadingEl.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                        switchLoadingEl.style.transform = `translate(calc(-50% + ${targetOffset}px), -50%)`;
                    }

                    // 动画结束后：先隐藏当前媒体，再切换，等新内容就绪后移除swipeContainer
                    setTimeout(() => {
                        if (moveTarget) {
                            moveTarget.style.transition = 'none';
                            moveTarget.style.opacity = '0';
                        }
                        // loading也同步隐藏
                        const swipeLoadingEl = contentEl.querySelector('.lightbox-loading');
                        if (swipeLoadingEl) {
                            swipeLoadingEl.style.transition = 'none';
                            swipeLoadingEl.style.opacity = '0';
                        }
                        changeMedia(direction);
                        preloadAdjacentMediaSizes();
                        // 等新图片解码/视频渲染后再移除swipeContainer并解锁
                        const newContentEl = document.getElementById('lightbox-content');
                        const newImg = newContentEl ? newContentEl.querySelector('img') : null;
                        const finishSwitch = () => {
                            removeSwipeContainer();
                            isMediaSwitching = false;
                        };
                        if (newImg && newImg.decode) {
                            let finished = false;
                            const safeFinish = () => { if (!finished) { finished = true; finishSwitch(); } };
                            newImg.decode().then(safeFinish).catch(safeFinish);
                            setTimeout(safeFinish, 500);
                        } else {
                            requestAnimationFrame(() => { requestAnimationFrame(finishSwitch); });
                        }
                    }, 260);
                } else {
                    // 回弹：滑回原位
                    swipeContainer.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                    swipeContainer.style.transform = `translateX(-${vw}px)`;
                    if (moveTarget) {
                        moveTarget.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                        moveTarget.style.transform = 'translateX(0)';
                    }
                    const bounceLoadingEl = contentEl.querySelector('.lightbox-loading');
                    if (bounceLoadingEl) {
                        bounceLoadingEl.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                        bounceLoadingEl.style.transform = 'translate(-50%, -50%)';
                    }

                    setTimeout(() => {
                        removeSwipeContainer();
                        if (moveTarget) {
                            moveTarget.style.transition = 'none';
                            moveTarget.style.transform = '';
                        }
                        if (bounceLoadingEl) {
                            bounceLoadingEl.style.transition = 'none';
                            bounceLoadingEl.style.transform = 'translate(-50%, -50%)';
                        }
                    }, 260);
                }
                return;
            }

            // 非跟手的快速滑动（PC端或未触发跟手的情况）
            if (!isSwiping && Math.abs(swipeX) > 50 && Math.abs(swipeX) > Math.abs(swipeY)) {
                lastTapTime = 0;
                if (swipeX > 0) { changeMedia(-1); } else { changeMedia(1); }
                return;
            }
            // 单击媒体外区域关闭灯箱（移动端未放大状态，用坐标判断）
            // 灯箱打开500ms内不响应关闭操作，防止双击误触
            if (isTap && !isDoubleTap && isMobileDevice() && (Date.now() - lightboxOpenTime > 500)) {
                const contentEl = document.getElementById('lightbox-content');
                const wrapperEl = contentEl ? contentEl.querySelector('.video-preview-wrapper') : null;
                const hitTarget = wrapperEl || currentImage;
                if (hitTarget) {
                    const hitRect = hitTarget.getBoundingClientRect();
                    if (endX < hitRect.left || endX > hitRect.right || endY < hitRect.top || endY > hitRect.bottom) {
                        closeLightbox();
                        return;
                    }
                } else {
                    closeLightbox();
                    return;
                }
            }
            // 双击图片：放大到2x（以触摸点为中心，带平滑动画）
            // 灯箱打开500ms内不响应双击，防止打开灯箱时的双击误触
            if (isDoubleTap && currentImage && currentImage.tagName === 'IMG' && (Date.now() - lightboxOpenTime > 500)) {
                lastTapTime = 0;
                const zoomImg = currentImage;
                const rect = zoomImg.getBoundingClientRect();
                const imgCenterX = rect.left + rect.width / 2;
                const imgCenterY = rect.top + rect.height / 2;
                const offsetX = touchStartX - imgCenterX;
                const offsetY = touchStartY - imgCenterY;
                const targetScale = 2;
                const targetTX = offsetX - offsetX * targetScale;
                const targetTY = offsetY - offsetY * targetScale;
                userZoomTransition = true;
                // 先确保当前帧无transition，并设置起始位置
                zoomImg.style.transition = 'none';
                updateImageTransform(zoomImg);
                // 强制重排确保起始位置已经应用
                void zoomImg.offsetHeight;
                // 双rAF确保transition在浏览器下一帧生效
                requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    currentScale = targetScale;
                    translateX = targetTX;
                    translateY = targetTY;
                    zoomImg.classList.add('zoomed');
                    zoomImg.style.transition = 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                    updateImageTransform(zoomImg);
                    updateMobileLightboxUI();
                    setTimeout(() => {
                        userZoomTransition = false;
                        if (currentImage) currentImage.style.transition = 'none';
                    }, 220);
                });
                });
                return;
            }
        } else {
            // 放大状态：双击缩小回1x
            if (isDoubleTap && currentImage) {
                lastTapTime = 0;
                const zoomImg = currentImage;
                userZoomTransition = true;
                zoomImg.style.transition = 'none';
                updateImageTransform(zoomImg);
                void zoomImg.offsetHeight;
                requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    currentScale = 1;
                    translateX = 0;
                    translateY = 0;
                    zoomImg.classList.remove('zoomed');
                    zoomImg.style.transition = 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                    updateImageTransform(zoomImg);
                    updateMobileLightboxUI();
                    setTimeout(() => {
                        userZoomTransition = false;
                        if (currentImage) currentImage.style.transition = 'none';
                    }, 220);
                });
                });
                return;
            }
            // 放大状态：单击空白区域关闭灯箱（用坐标判断，因为touch target始终是touchstart元素）
            if (isTap && !touchMoved && currentImage) {
                const rect = currentImage.getBoundingClientRect();
                if (endX < rect.left || endX > rect.right || endY < rect.top || endY > rect.bottom) {
                    closeLightbox();
                    return;
                }
            }
        }
        if (isTap) lastTapTime = now;
    });

    // 监听视频的鼠标悬停事件（用于判断方向键是切换媒体还是快进快退）
    content.addEventListener('mouseenter', function (e) {
        if (e.target.tagName === 'VIDEO') {
            isVideoHovered = true;
        }
    }, true);

    content.addEventListener('mouseleave', function (e) {
        if (e.target.tagName === 'VIDEO') {
            isVideoHovered = false;
        }
    }, true);
}

// ==================== 页面装饰模块 ====================

/** 为页面头部添加装饰点阵背景和左右菱形装饰 */
function addHeaderBgDots() {
    const headers = document.querySelectorAll('.page_header');
    headers.forEach(header => {
        // 添加装饰点阵
        if (!header.querySelector('.bg-dots')) {
            const dots = document.createElement('div');
            dots.className = 'bg-dots';
            header.insertBefore(dots, header.firstChild);
        }

        // 添加左右菱形
        const text = header.querySelector('.text');
        if (text && !header.querySelector('.decoration-left')) {
            // 创建包装容器
            const wrapper = document.createElement('div');
            wrapper.className = 'text-wrapper';

            // 用包装容器替换文字元素
            text.parentNode.insertBefore(wrapper, text);
            wrapper.appendChild(text);

            // 添加左菱形
            const leftDeco = document.createElement('span');
            leftDeco.className = 'decoration-left';
            wrapper.insertBefore(leftDeco, text);

            // 添加右菱形
            const rightDeco = document.createElement('span');
            rightDeco.className = 'decoration-right';
            wrapper.appendChild(rightDeco);
        }
    });
}

// ==================== 日期与消息处理模块 ====================

/** 将Telegram导出的英文日期（如 "26 October 2023"）转换为中文格式（"2023-10-26"） */
function convertDates() {
    const monthMap = {
        'January': '01', 'February': '02', 'March': '03', 'April': '04',
        'May': '05', 'June': '06', 'July': '07', 'August': '08',
        'September': '09', 'October': '10', 'November': '11', 'December': '12'
    };

    const serviceDates = document.querySelectorAll('.message.service .body.details');
    serviceDates.forEach(dateElement => {
        const text = dateElement.textContent.trim();
        // 匹配格式：26 October 2023
        const match = text.match(/(\d+)\s+(\w+)\s+(\d{4})/);
        if (match) {
            const day = match[1].padStart(2, '0');
            const month = monthMap[match[2]];
            const year = match[3];
            if (month) {
                dateElement.textContent = `${year}-${month}-${day}`;
                dateElement.setAttribute('data-date', `${year}-${month}-${day}`);
            }
        }
    });
}

/**
 * 重新组织消息结构
 * 将Telegram的joined消息（连续发送的消息被拆分为多条）合并回主消息中，
 * 包括合并媒体和文本内容，并隐藏forwarded消息中的冗余时间戳
 */
function reorganizeMessages() {
    const messages = document.querySelectorAll('.message.default');
    let currentMainMessage = null;
    let addedTexts = new Set();

    messages.forEach((message) => {
        const hasJoined = message.classList.contains('joined');
        const hasFromName = message.querySelector('.from_name');

        // 如果不是joined消息，这是新的主消息
        if (!hasJoined) {
            currentMainMessage = message;
            message.style.display = 'flex';
            
            addedTexts = new Set();
            
            const mainText = message.querySelector('.text');
            if (mainText && mainText.textContent.trim()) {
                addedTexts.add(mainText.textContent.trim());
            }
        }
        // 如果是joined消息，合并到主消息
        else if (currentMainMessage) {
            const mediaWrap = message.querySelector('.media_wrap');
            const textContent = message.querySelector('.text');

            if (mediaWrap) {
                const mainMediaWrap = currentMainMessage.querySelector('.media_wrap');
                if (mainMediaWrap) {
                    const mediaItems = mediaWrap.querySelectorAll('.photo_wrap, .video_file_wrap');
                    mediaItems.forEach(item => {
                        mainMediaWrap.appendChild(item);
                    });
                }
            }

            if (textContent && textContent.textContent.trim()) {
                const mainBody = currentMainMessage.querySelector('.body');
                if (mainBody) {
                    const currentTextRaw = textContent.textContent.trim();
                    
                    if (!addedTexts.has(currentTextRaw)) {
                        addedTexts.add(currentTextRaw);

                        let mainText = mainBody.querySelector('.text');
                        if (!mainText) {
                            mainText = document.createElement('div');
                            mainText.className = 'text';
                            mainBody.appendChild(mainText);
                        }

                        if (!mainText.innerHTML.trim()) {
                            mainText.innerHTML = textContent.innerHTML;
                        } else {
                            mainText.innerHTML += '<br>' + textContent.innerHTML;
                        }
                    }
                }
            }

            message.style.display = 'none';
        }
    });

    // 移除forwarded消息中的原版时间显示
    document.querySelectorAll('.forwarded.body .date.details').forEach(el => {
        el.style.display = 'none';
    });
}

// ==================== 媒体收集与筛选模块 ====================

/**
 * 收集页面中所有媒体元素（图片和视频），按DOM顺序混合排列
 * 修复文件名中#号导致的URL解析问题，并为每个媒体绑定灯箱打开事件
 */
function collectMedia() {
    mediaItems = []; // 清空数组

    // 按DOM顺序同时选择图片和视频，实现灯箱中图片视频按顺序切换
    const allMedia = document.querySelectorAll('.photo_wrap, .video_file_wrap');

    allMedia.forEach((item) => {
        const isVideo = item.classList.contains('video_file_wrap');
        let href = item.getAttribute('href') || '';
        // 修复文件名包含#导致URL解析错误的问题
        href = href.replace(/#/g, '%23');

        // 获取缩略图src（视频和图片都保存）
        const thumbImg = item.querySelector(isVideo ? 'img.video_file' : 'img.photo');
        let thumbSrc = thumbImg ? (thumbImg.getAttribute('src') || '') : '';
        thumbSrc = thumbSrc.replace(/#/g, '%23');

        mediaItems.push({
            type: isVideo ? 'video' : 'image',
            src: href,
            thumb: thumbSrc,
            element: item
        });

        // 修复thumbnail src
        const img = item.querySelector(isVideo ? 'img.video_file' : 'img.photo');
        if (img) {
            let src = img.getAttribute('src') || '';
            src = src.replace(/#/g, '%23');
            img.setAttribute('src', src);
        }

        // 添加点击事件
        item.addEventListener('click', function (e) {
            e.preventDefault();
            openLightbox(mediaItems.findIndex(m => m.element === item));
        });
    });

    // 初始化筛选后的媒体列表
    applyMediaFilter();
}

/** 根据当前筛选模式（全部/图片/视频）过滤媒体列表 */
function applyMediaFilter() {
    if (mediaFilterMode === 'all') {
        filteredMediaItems = mediaItems.slice();
    } else {
        filteredMediaItems = mediaItems.filter(m => m.type === mediaFilterMode);
    }
}

/** 根据当前媒体类型动态更新筛选按钮（只显示"全部"和当前媒体类型） */
function updateFilterButtons(currentMediaType) {
    const filterContainer = document.getElementById('lightbox-filter');
    if (!filterContainer) return;

    const typeLabel = currentMediaType === 'image' ? '图片' : '视频';
    filterContainer.innerHTML = `
        <button class="lightbox-filter-btn${mediaFilterMode === 'all' ? ' active' : ''}" data-filter="all" onclick="setMediaFilter('all')">全部</button>
        <button class="lightbox-filter-btn${mediaFilterMode === currentMediaType ? ' active' : ''}" data-filter="${currentMediaType}" onclick="setMediaFilter('${currentMediaType}')">${typeLabel}</button>
    `;
}

/** 切换媒体筛选模式，保持当前媒体在新列表中的位置 */
function setMediaFilter(mode) {
    const currentMedia = filteredMediaItems[currentIndex];
    mediaFilterMode = mode;
    applyMediaFilter();

    // 更新筛选按钮状态
    document.querySelectorAll('.lightbox-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === mode);
    });

    // 尝试保持当前媒体在新筛选结果中的位置
    if (currentMedia) {
        const newIdx = filteredMediaItems.indexOf(currentMedia);
        currentIndex = newIdx >= 0 ? newIdx : 0;
    } else {
        currentIndex = 0;
    }

    if (filteredMediaItems.length > 0) {
        showMedia();
    }
}

/** 检测是否为移动端 */
function isMobileDevice() {
    return window.innerWidth <= 768;
}

/** 打开灯箱并显示指定索引的媒体，PC端从缩略图展开，移动端淡入 */
function openLightbox(index) {
    // 每次打开灯箱重置为"全部"模式
    mediaFilterMode = 'all';
    applyMediaFilter();

    const targetMedia = mediaItems[index];
    const filteredIdx = filteredMediaItems.indexOf(targetMedia);
    currentIndex = filteredIdx >= 0 ? filteredIdx : 0;

    // 根据点击的媒体类型生成筛选按钮
    if (targetMedia) {
        updateFilterButtons(targetMedia.type);
    }

    const lightbox = document.getElementById('lightbox');
    lightbox.classList.remove('closing');

    // 锁定滚动：移动端用position:fixed保存滚动位置（不修改html的overflow，避免reflow导致GPU释放图片纹理闪白）
    const isMobile = isMobileDevice();
    if (isMobile) {
        const scrollY = window.scrollY;
        document.body.dataset.scrollY = scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.overscrollBehavior = 'none';
        document.body.style.touchAction = 'none';
    } else {
        document.body.style.overflow = 'hidden';
    }
    lightbox.classList.add('active');
    lightboxOpenTime = Date.now();

    // 记录缩略图位置用于展开动画（仅PC端）
    const thumbEl = targetMedia ? targetMedia.element : null;
    const thumbRect = (!isMobile && thumbEl) ? thumbEl.getBoundingClientRect() : null;

    const contentEl = document.getElementById('lightbox-content');
    // 预加载相邻媒体尺寸（用于滑动预览精确匹配）
    preloadAdjacentMediaSizes();

    // 立即调用showMedia，不等待任何异步加载
    showMedia();

    const mediaEl = contentEl ? (contentEl.querySelector('img') || contentEl.querySelector('video')) : null;
    const openAnimTarget = (contentEl ? contentEl.querySelector('.video-preview-wrapper') : null) || mediaEl;

    if (isMobile) {
        // 移动端入场动画：先隐藏内容设初始状态，decode完成或超时后统一显示
        if (openAnimTarget) {
            openAnimTarget.style.transition = 'none';
            openAnimTarget.style.opacity = '0';
            openAnimTarget.style.transform = 'scale(0.92) translateZ(0)';
            openAnimTarget.style.willChange = 'transform, opacity';
        }
        // 背景遮罩立即开始淡入（不等内容加载）
        lightbox.classList.add('bg-visible');

        const runEntryAnim = () => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (openAnimTarget) {
                        openAnimTarget.style.transition = 'opacity 0.18s ease-out, transform 0.18s ease-out';
                        openAnimTarget.style.opacity = '1';
                        openAnimTarget.style.transform = 'scale(1) translateZ(0)';
                        setTimeout(() => {
                            if (openAnimTarget && !userZoomTransition) {
                                openAnimTarget.style.transition = 'none';
                                openAnimTarget.style.transform = '';
                                openAnimTarget.style.willChange = '';
                            }
                        }, 200);
                    }
                });
            });
        };
        // 图片：等decode完成(最多300ms超时)再显示内容动画；视频/其他：下一帧显示
        const imgEl = contentEl.querySelector('img');
        if (imgEl && imgEl.decode) {
            let decoded = false;
            const onDecode = () => { if (!decoded) { decoded = true; runEntryAnim(); } };
            imgEl.decode().then(onDecode).catch(onDecode);
            setTimeout(onDecode, 300);
        } else {
            runEntryAnim();
        }
    } else if (thumbRect && mediaEl) {
        const img = mediaEl;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const thumbCX = thumbRect.left + thumbRect.width / 2;
        const thumbCY = thumbRect.top + thumbRect.height / 2;
        const viewCX = vw / 2;
        const viewCY = vh / 2;
        const maxW = vw * 0.95;
        const maxH = vh * 0.95;
        const naturalW = img.naturalWidth || img.videoWidth || maxW;
        const naturalH = img.naturalHeight || img.videoHeight || maxH;
        const ratio = Math.min(maxW / naturalW, maxH / naturalH, 1);
        const finalW = naturalW * ratio || maxW;
        const scaleFrom = Math.max(thumbRect.width / finalW, 0.05);
        const dx = thumbCX - viewCX;
        const dy = thumbCY - viewCY;

        img.style.transition = 'none';
        img.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleFrom})`;
        img.style.opacity = '0.6';
        img.style.borderRadius = '12px';
        img.offsetHeight;
        img.style.transition = 'transform 0.45s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.3s ease, border-radius 0.45s ease';
        img.style.transform = 'translate(0, 0) scale(1)';
        img.style.opacity = '1';
        img.style.borderRadius = '';
        requestAnimationFrame(() => { lightbox.classList.add('bg-visible'); });
        setTimeout(() => {
            img.style.transition = '';
            // 仅在未缩放状态下清空transform，避免覆盖用户已触发的放大操作
            if (currentScale <= 1) { img.style.transform = ''; }
        }, 480);
    } else {
        lightbox.classList.add('bg-visible');
    }
}

/** 关闭灯箱，PC端淡出+微缩动画，移动端淡出 */
function closeLightbox() {
    // 切换动画中或视频全屏时禁止关闭灯箱
    if (isMediaSwitching || isVideoFullscreen) return;
    const lightbox = document.getElementById('lightbox');
    const content = document.getElementById('lightbox-content');
    const img = currentImage || (content ? (content.querySelector('img') || content.querySelector('video')) : null);

    // 重置所有状态标志
    currentScale = 1;
    translateX = 0;
    translateY = 0;
    isDragging = false;
    isMediaSwitching = false;
    userZoomTransition = false;
    isVideoFullscreen = false;

    // 清理滑动容器（如果存在）
    const swipeEl = content ? content.querySelector('.swipe-container') : null;
    if (swipeEl) swipeEl.remove();

    // 隐藏所有按钮
    const buttons = lightbox.querySelectorAll('.lightbox-close, .lightbox-prev, .lightbox-next, .lightbox-filter, .lightbox-counter');
    buttons.forEach(b => { b.style.opacity = '0'; b.style.transition = 'opacity 0.2s ease'; });

    // 背景淡出
    lightbox.classList.add('closing');
    lightbox.classList.remove('bg-visible');

    // 媒体淡出+微缩动画（PC和移动端统一，流畅不卡顿）
    // 优先动画wrapper（含播放按钮），否则动画媒体元素本身
    const closeTarget = (content ? content.querySelector('.video-preview-wrapper') : null) || img;
    if (closeTarget) {
        closeTarget.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        closeTarget.style.opacity = '0';
        closeTarget.style.transform = 'scale(0.9)';
    }
    // loading动画同步淡出（与媒体一起消失，不残留）
    const closingLoading = content ? content.querySelector('.lightbox-loading') : null;
    if (closingLoading) {
        closingLoading.style.transition = 'opacity 0.3s ease';
        closingLoading.style.opacity = '0';
    }

    // 动画结束后清理
    setTimeout(() => {
        lightbox.classList.remove('active', 'closing', 'bg-visible');
        // 恢复滚动
        const savedScrollY = parseInt(document.body.dataset.scrollY || '0', 10);
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        document.body.style.overscrollBehavior = '';
        document.body.style.touchAction = '';
        // 恢复滚动位置（position:fixed方案会导致滚动位置丢失）
        if (savedScrollY > 0) {
            window.scrollTo(0, savedScrollY);
        }
        mediaFilterMode = 'all';
        content.innerHTML = '';
        seekIndicatorElement = null;
        currentImage = null;
        buttons.forEach(b => { b.style.opacity = ''; b.style.transition = ''; });
    }, 320);
}

/**
 * 显示当前索引的媒体（图片或视频）
 * 图片：支持点击缩放、滚轮缩放、拖拽移动
 * 视频：支持滚轮缩放、自动播放、键盘快进快退
 */
function showMedia() {
    // 重置之前的缩放
    resetZoom();

    const content = document.getElementById('lightbox-content');
    const counter = document.getElementById('lightbox-counter');

    if (filteredMediaItems.length === 0) return;
    const media = filteredMediaItems[currentIndex];
    if (!media) return;

    // 根据当前媒体类型动态更新筛选按钮
    updateFilterButtons(media.type);

    // 清空之前的内容（同步重置seek指示器引用）
    content.innerHTML = '';
    seekIndicatorElement = null;

    if (media.type === 'image') {
        const img = document.createElement('img');
        img.alt = 'Image';
        const isMobile = isMobileDevice();
        // 移动端禁用CSS默认transition，防止切换时尺寸变化动画
        if (isMobile) {
            img.style.transition = 'none';
        }

        // 有缓存尺寸时精确设宽高（与createSlidePreview完全一致，消除切换尺寸偏差）
        // 加载前隐藏边框阴影（避免加载失败时残留空白容器边框）
        const imgDisplaySize = calcMediaDisplaySize(media);
        if (imgDisplaySize) {
            img.style.width = imgDisplaySize.width + 'px';
            img.style.height = imgDisplaySize.height + 'px';
            img.style.objectFit = 'contain';
        }
        img.style.boxShadow = 'none';
        img.style.borderRadius = '0';

        // 立即赋值currentImage（不等onload），确保双击放大在图片刚显示时就能工作
        currentImage = img;

        // 获取DOM中已渲染的缩略图src（网络异常兜底用）
        const domThumbImg = media.element ? media.element.querySelector('img') : null;
        const domThumbSrc = domThumbImg ? domThumbImg.src : '';
        const thumbFallbackSrc = media.thumb || domThumbSrc;
        const hasThumb = thumbFallbackSrc && thumbFallbackSrc !== media.src;

        // 状态控制
        let imgLoadHandled = false;
        let loadingTimer = null;

        // 后台用new Image加载原图（不中断当前img的显示）
        const bgLoader = new Image();

        const removeLoading = () => {
            const ld = content.querySelector('.lightbox-loading');
            if (ld) ld.remove();
        };

        const restoreBorder = () => {
            img.style.boxShadow = '';
            img.style.borderRadius = '';
        };

        const showLoading = () => {
            if (!content.querySelector('.lightbox-loading')) {
                const loadingEl = document.createElement('div');
                loadingEl.className = 'lightbox-loading';
                loadingEl.innerHTML = '<div class="lightbox-spinner"></div>';
                content.appendChild(loadingEl);
            }
        };

        // 事件绑定（在img创建后立即绑定，不等onload）
        img.addEventListener('wheel', handleWheel, { passive: false });

        let imgDragStartX = 0, imgDragStartY = 0, imgWasDragged = false;
        img.addEventListener('mousedown', function (e) {
            imgDragStartX = e.clientX; imgDragStartY = e.clientY;
            imgWasDragged = false; startDrag(e);
        });
        img.addEventListener('mousemove', function (e) {
            if (isDragging) {
                if (Math.abs(e.clientX - imgDragStartX) > 3 || Math.abs(e.clientY - imgDragStartY) > 3) imgWasDragged = true;
            }
        });
        img.addEventListener('click', function (e) {
            if (isMobileDevice()) return;
            if (imgWasDragged) { imgWasDragged = false; e.preventDefault(); return; }
            if (currentScale <= 1) {
                const oldScale = currentScale, newScale = 2;
                const rect = img.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
                const mouseOffsetX = e.clientX - centerX, mouseOffsetY = e.clientY - centerY;
                const scaleRatio = newScale / oldScale;
                translateX = translateX + mouseOffsetX - mouseOffsetX * scaleRatio;
                translateY = translateY + mouseOffsetY - mouseOffsetY * scaleRatio;
                currentScale = newScale; img.style.cursor = 'grab'; img.classList.add('zoomed');
            } else {
                currentScale = 1; translateX = 0; translateY = 0;
                img.style.cursor = 'zoom-in'; img.classList.remove('zoomed');
            }
            updateImageTransform(img); e.preventDefault();
        });
        img.style.cursor = 'zoom-in';

        // 策略：先检查原图是否已在浏览器缓存中
        const origProbe = new Image();
        origProbe.src = media.src;
        const isOrigCached = origProbe.complete && origProbe.naturalWidth > 0;

        if (isOrigCached) {
            // 原图已缓存：直接显示原图，不显示缩略图也不显示loading
            img.src = media.src;
            imgLoadHandled = true;
            restoreBorder();
        } else if (hasThumb) {
            // 有缩略图：先显示缩略图预览，后台同时加载原图
            img.src = thumbFallbackSrc;
            restoreBorder(); // 缩略图有画面，立即显示边框
            bgLoader.onload = function() {
                if (imgLoadHandled) return;
                imgLoadHandled = true;
                if (loadingTimer) clearTimeout(loadingTimer);
                img.src = bgLoader.src;
                removeLoading();
            };
            bgLoader.onerror = function() {
                if (imgLoadHandled) return;
                // 原图加载失败，保留缩略图，移除loading
                imgLoadHandled = true;
                if (loadingTimer) clearTimeout(loadingTimer);
                removeLoading();
            };
            bgLoader.src = media.src;

            // 100ms后如果原图还没好，显示loading（缩略图已经在显示了）
            loadingTimer = setTimeout(() => {
                if (imgLoadHandled) return;
                showLoading();
            }, 100);
        } else {
            // 无缩略图：直接加载原图
            img.src = media.src;
            img.onload = function() {
                if (imgLoadHandled) return;
                imgLoadHandled = true;
                if (loadingTimer) clearTimeout(loadingTimer);
                removeLoading();
                restoreBorder();
            };
            // 100ms后如果原图还没好，显示loading
            loadingTimer = setTimeout(() => {
                if (imgLoadHandled) return;
                showLoading();
            }, 100);
        }

        // 图片加载失败：兜底处理
        img.onerror = function() {
            if (imgLoadHandled) return;
            // 1) 尝试用缩略图兜底（如果当前不是缩略图）
            if (hasThumb && !img.src.endsWith(thumbFallbackSrc)) {
                img.src = thumbFallbackSrc;
                return;
            }
            // 2) 全部失败：从DOM移除img元素（不显示任何空白容器），只保留loading
            imgLoadHandled = true;
            if (loadingTimer) clearTimeout(loadingTimer);
            if (img.parentNode) img.parentNode.removeChild(img);
            showLoading();
            const lb = document.getElementById('lightbox');
            if (lb && !lb.classList.contains('bg-visible')) lb.classList.add('bg-visible');
        };

        content.appendChild(img);
    } else if (media.type === 'video') {
        if (isMobileDevice()) {
            // 移动端：用video元素显示poster预览图 + 播放按钮，后台预加载视频
            const wrapper = document.createElement('div');
            wrapper.className = 'video-preview-wrapper';
            wrapper.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;max-width:95vw;max-height:95vh;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1);overflow:hidden;';

            const preloadVideo = document.createElement('video');
            preloadVideo.preload = 'auto';
            preloadVideo.setAttribute('playsinline', '');
            preloadVideo.setAttribute('webkit-playsinline', '');

            // poster来源：优先用thumb，网络异常时用DOM中已渲染的缩略图
            const domVideoThumb = media.element ? media.element.querySelector('img') : null;
            const posterSrc = media.thumb || (domVideoThumb ? domVideoThumb.src : '');

            const videoDisplaySize = calcMediaDisplaySize(media);
            if (videoDisplaySize) {
                // 有缓存尺寸：wrapper精确匹配视频比例，视频100%填满wrapper
                if (posterSrc) preloadVideo.poster = posterSrc;
                wrapper.style.width = videoDisplaySize.width + 'px';
                wrapper.style.height = videoDisplaySize.height + 'px';
                preloadVideo.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;background:transparent;box-shadow:none;border-radius:0;';
            } else {
                // 无缓存尺寸：绝不显示poster（避免尺寸跳变），wrapper无边框无阴影，只保留最小尺寸给播放按钮定位
                preloadVideo.style.cssText = 'width:0;height:0;display:block;pointer-events:none;box-shadow:none;border-radius:0;';
                wrapper.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;max-width:95vw;max-height:95vh;min-width:120px;min-height:120px;overflow:hidden;';
            }
            wrapper.appendChild(preloadVideo);

            // 设置视频src（在poster设置好之后，避免poster被清空）
            preloadVideo.src = media.src;

            // 视频元数据加载后用精确宽高更新尺寸
            preloadVideo.addEventListener('loadedmetadata', function() {
                const vw = preloadVideo.videoWidth;
                const vh = preloadVideo.videoHeight;
                if (vw && vh) {
                    mediaSizeCache[media.src] = { width: vw, height: vh };
                    const ds = calcMediaDisplaySize(media);
                    if (ds) {
                        // 恢复wrapper为完整样式（含圆角、阴影、overflow）
                        wrapper.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;max-width:95vw;max-height:95vh;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1);overflow:hidden;';
                        wrapper.style.width = ds.width + 'px';
                        wrapper.style.height = ds.height + 'px';
                        preloadVideo.style.width = '100%';
                        preloadVideo.style.height = '100%';
                        preloadVideo.style.objectFit = 'cover';
                    }
                    if (!preloadVideo.poster && posterSrc) {
                        preloadVideo.poster = posterSrc;
                    }
                }
            });

            // 播放按钮：根据视频可播放状态显示不同样式
            const playBtn = document.createElement('div');
            playBtn.className = 'video-play-btn';
            const playBtnBaseStyle = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;color:white;font-size:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.3);pointer-events:auto;z-index:5;';
            let videoCanPlay = false;

            // 初始状态：视频未就绪，显示转圈边框加载按钮（外圈旋转，▶不旋转）
            const setLoadingBtn = () => {
                playBtn.innerHTML = '<div style="position:absolute;inset:0;border-radius:50%;border:3px solid rgba(255,255,255,0.15);border-top-color:rgba(255,255,255,0.8);animation:lightboxSpin 0.8s linear infinite;"></div><span style="position:relative;padding-left:3px;">▶</span>';
                playBtn.style.cssText = playBtnBaseStyle + 'background:rgba(0,0,0,0.45);backdrop-filter:blur(8px);border:none;';
            };
            const setReadyBtn = () => {
                playBtn.innerHTML = '<span style="padding-left:3px;">▶</span>';
                playBtn.style.cssText = playBtnBaseStyle + 'background:rgba(0,0,0,0.55);backdrop-filter:blur(8px);border:2px solid rgba(255,255,255,0.3);transition:transform 0.2s ease,background 0.2s ease;';
            };

            setLoadingBtn();
            preloadVideo.addEventListener('canplay', function() {
                videoCanPlay = true;
                setReadyBtn();
            }, { once: true });
            // 如果视频加载出错，保持加载状态按钮
            preloadVideo.addEventListener('error', function() {
                // 确保背景遮罩可见
                const lb = document.getElementById('lightbox');
                if (lb && !lb.classList.contains('bg-visible')) {
                    lb.classList.add('bg-visible');
                }
            }, { once: true });

            wrapper.appendChild(playBtn);
            currentImage = preloadVideo;

            // 点击播放按钮
            playBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                // 统一的播放启动逻辑
                const startPlayback = () => {
                    playBtn.remove();
                    preloadVideo.style.pointerEvents = 'auto';
                    preloadVideo.id = 'current-video';
                    preloadVideo.style.cursor = 'default';
                    currentImage = preloadVideo;
                    preloadVideo.addEventListener('wheel', handleWheel, { passive: false });
                    // 全屏事件：瞬间切换样式（transition:none避免白条闪烁）
                    const handleFsChange = () => {
                        const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
                        isVideoFullscreen = isFull;
                        // 瞬间切换，不要过渡动画
                        wrapper.style.transition = 'none';
                        if (isFull) {
                            wrapper.style.borderRadius = '0';
                            wrapper.style.boxShadow = 'none';
                            wrapper.style.overflow = 'visible';
                        } else {
                            // 退出全屏：延迟一帧恢复圆角，避免闪烁
                            requestAnimationFrame(() => {
                                wrapper.style.borderRadius = '20px';
                                wrapper.style.boxShadow = '0 20px 60px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.1)';
                                wrapper.style.overflow = 'hidden';
                            });
                        }
                    };
                    preloadVideo.addEventListener('fullscreenchange', handleFsChange);
                    preloadVideo.addEventListener('webkitfullscreenchange', handleFsChange);
                    preloadVideo.play().then(() => {
                        setTimeout(() => { preloadVideo.controls = true; }, 300);
                    }).catch(() => { preloadVideo.controls = true; });
                };

                if (videoCanPlay) {
                    startPlayback();
                } else {
                    // 视频未就绪，显示加载中状态，等canplay后自动播放
                    setLoadingBtn();
                    playBtn.style.pointerEvents = 'none';
                    preloadVideo.addEventListener('canplay', () => { startPlayback(); }, { once: true });
                    // 10秒超时：恢复可点击按钮
                    setTimeout(() => {
                        if (!videoCanPlay && playBtn.parentNode) {
                            setLoadingBtn();
                            playBtn.style.pointerEvents = 'auto';
                        }
                    }, 10000);
                }
            });

            content.appendChild(wrapper);
        } else {
            // PC端：直接播放视频
            const video = document.createElement('video');
            video.src = media.src;
            video.controls = true;
            video.autoplay = true;
            video.style.maxWidth = '100%';
            video.style.maxHeight = '90vh';
            video.id = 'current-video';

            // 添加视频缩放支持（只缩放，不拖拽）
            currentImage = video;
            video.addEventListener('wheel', handleWheel, { passive: false });

            // 设置视频光标样式
            video.style.cursor = 'default';

            content.appendChild(video);
        }
    }

    // 更新计数器并设置自动隐藏
    counter.textContent = `${currentIndex + 1} / ${filteredMediaItems.length}`;
    counter.style.opacity = '1';

    // 0.5秒后自动隐藏计数器
    setTimeout(() => {
        counter.style.opacity = '0';
    }, 500);
}

// ==================== 图片缩放与拖拽模块 ====================

let currentImage = null;   // 当前操作的图片/视频元素
let currentScale = 1;      // 当前缩放比例
let translateX = 0;        // X轴平移量
let translateY = 0;        // Y轴平移量
let isDragging = false;    // 是否正在拖拽
let startX, startY;        // 拖拽起始坐标
let lastX, lastY;          // 拖拽前的平移量

/** 滚轮缩放处理：以鼠标位置为中心进行缩放（0.5x ~ 5x） */
function handleWheel(e) {
    e.preventDefault();
    e.stopPropagation();

    const oldScale = currentScale;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(0.5, Math.min(5, currentScale + delta));

    if (newScale === currentScale) return; // 没有变化就返回

    // 获取图片的边界框
    const rect = currentImage.getBoundingClientRect();

    // 鼠标相对于图片中心的位置
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const mouseOffsetX = e.clientX - centerX;
    const mouseOffsetY = e.clientY - centerY;

    // 计算缩放比例变化
    const scaleRatio = newScale / oldScale;

    // 调整平移，使鼠标位置保持不变
    // 因为 transformOrigin 是 center，所以需要调整平移量
    translateX = translateX + mouseOffsetX - mouseOffsetX * scaleRatio;
    translateY = translateY + mouseOffsetY - mouseOffsetY * scaleRatio;

    currentScale = newScale;
    updateImageTransform(currentImage);

    // 更新光标和类
    const isVideo = currentImage.tagName === 'VIDEO';
    if (currentScale > 1) {
        // 放大后：图片显示 grab，视频显示 default
        currentImage.style.cursor = isVideo ? 'default' : 'grab';
        currentImage.classList.add('zoomed');
    } else {
        // 缩小后：图片显示 zoom-in，视频显示 default
        currentImage.style.cursor = isVideo ? 'default' : 'zoom-in';
        currentImage.classList.remove('zoomed');
    }
}

/** 更新图片/视频的transform样式（平移+缩放） */
function updateImageTransform(img) {
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
    img.style.transformOrigin = 'center center';
}

/** 开始拖拽：记录起始位置，禁用transition实现即时跟手（仅图片放大后可拖拽） */
function startDrag(e) {
    if (currentScale <= 1) return;

    // 视频不支持拖拽
    const isVideo = currentImage.tagName === 'VIDEO';
    if (isVideo) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    lastX = translateX;
    lastY = translateY;

    // 禁用transition实现拖拽即时跟手
    currentImage.style.transition = 'none';
    // 拖拽时显示 grabbing（只有图片）
    currentImage.style.cursor = 'grabbing';

    e.preventDefault();
    e.stopPropagation();
}

/** 拖拽中：实时更新图片位置 */
function drag(e) {
    if (!isDragging) return;
    e.preventDefault();

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    translateX = lastX + dx;
    translateY = lastY + dy;

    updateImageTransform(currentImage);
}

/** 拖拽结束：恢复transition和光标样式 */
function endDrag() {
    if (!isDragging) return;
    isDragging = false;

    // PC端恢复CSS默认transition（用于点击缩放动画）；移动端保持none（由触摸逻辑控制）
    if (currentImage) {
        currentImage.style.transition = isMobileDevice() ? 'none' : '';
        if (currentScale > 1) {
            const isVideo = currentImage.tagName === 'VIDEO';
            currentImage.style.cursor = isVideo ? 'default' : 'grab';
        }
    }
}

// 全局拖拽事件（绑定在document上以支持鼠标移出图片区域后继续拖拽）
document.addEventListener('mousemove', drag);
document.addEventListener('mouseup', endDrag);

/** 重置缩放状态：清除事件监听、恢复样式、重置变量 */
function resetZoom() {
    if (currentImage) {
        currentImage.removeEventListener('wheel', handleWheel);
        currentImage.classList.remove('zoomed');
        currentImage.style.transform = '';
        currentImage.style.cursor = 'zoom-in';
    }
    currentScale = 1;
    translateX = 0;
    translateY = 0;
    currentImage = null;
    isDragging = false;
}

/** 切换媒体（循环切换，direction: -1上一个 / 1下一个） */
function changeMedia(direction) {
    if (filteredMediaItems.length === 0) return;
    currentIndex += direction;

    // 循环
    if (currentIndex < 0) {
        currentIndex = filteredMediaItems.length - 1;
    } else if (currentIndex >= filteredMediaItems.length) {
        currentIndex = 0;
    }

    showMedia();
}

// ==================== 键盘控制与视频快进快退模块 ====================

let isVideoHovered = false;       // 鼠标是否悬停在视频上
let seekInterval = null;          // 快进快退定时器ID
let seekAmount = 5;               // 快进快退步长（秒）
let seekIndicatorElement = null;  // 快进快退指示器DOM元素
let seekSpeed = 1;                // 快进速度倍数（长按时递增）
let seekPressTime = 0;            // 按键按下时间戳
let hideIndicatorTimeout = null;  // 指示器隐藏定时器
let longPressThreshold = 300;     // 长按判定阈值（毫秒）
let isLongPress = false;          // 是否为长按操作

document.addEventListener('keydown', function (e) {
    const lightbox = document.getElementById('lightbox');
    if (!lightbox.classList.contains('active')) return;

    // 检查是否有视频
    const video = document.getElementById('current-video');

    if (e.key === 'Escape') {
        closeLightbox();
    } else if (e.key === 'ArrowLeft') {
        // 如果鼠标在视频上，快退
        if (video && isVideoHovered) {
            if (!seekInterval && !e.repeat) {
                // 记录按下时间
                seekPressTime = Date.now();
                isLongPress = false;

                // 延迟启动长按模式
                seekInterval = setTimeout(() => {
                    isLongPress = true;
                    seekSpeed = 1;

                    // 启动连续快退
                    const continuousSeek = setInterval(() => {
                        // 根据按下时长增加速度（更平滑的加速曲线）
                        const pressDuration = (Date.now() - seekPressTime) / 1000;
                        if (pressDuration > 4) {
                            seekSpeed = 4;
                        } else if (pressDuration > 2.5) {
                            seekSpeed = 3;
                        } else if (pressDuration > 1.5) {
                            seekSpeed = 2.5;
                        } else if (pressDuration > 0.8) {
                            seekSpeed = 2;
                        } else if (pressDuration > 0.3) {
                            seekSpeed = 1.5;
                        } else {
                            seekSpeed = 1;
                        }
                        seekVideoSmooth(video, -1);
                    }, 50);

                    seekInterval = continuousSeek;
                }, longPressThreshold);
            }
            e.preventDefault();
        } else {
            // 否则切换到上一个媒体
            changeMedia(-1);
        }
    } else if (e.key === 'ArrowRight') {
        // 如果鼠标在视频上，快进
        if (video && isVideoHovered) {
            if (!seekInterval && !e.repeat) {
                // 记录按下时间
                seekPressTime = Date.now();
                isLongPress = false;

                // 延迟启动长按模式
                seekInterval = setTimeout(() => {
                    isLongPress = true;
                    seekSpeed = 1;

                    // 启动连续快进
                    const continuousSeek = setInterval(() => {
                        // 根据按下时长增加速度（更平滑的加速曲线）
                        const pressDuration = (Date.now() - seekPressTime) / 1000;
                        if (pressDuration > 4) {
                            seekSpeed = 4;
                        } else if (pressDuration > 2.5) {
                            seekSpeed = 3;
                        } else if (pressDuration > 1.5) {
                            seekSpeed = 2.5;
                        } else if (pressDuration > 0.8) {
                            seekSpeed = 2;
                        } else if (pressDuration > 0.3) {
                            seekSpeed = 1.5;
                        } else {
                            seekSpeed = 1;
                        }
                        seekVideoSmooth(video, 1);
                    }, 50);

                    seekInterval = continuousSeek;
                }, longPressThreshold);
            }
            e.preventDefault();
        } else {
            // 否则切换到下一个媒体
            changeMedia(1);
        }
    } else if (e.key === ' ' && video) {
        // 空格键暂停/播放视频
        if (video.paused) {
            video.play();
        } else {
            video.pause();
        }
        e.preventDefault();
    } else if (e.key === '1' && video) {
        seekAmount = 1;
        showMessage('快进/快退: 1秒');
    } else if (e.key === '2' && video) {
        seekAmount = 2;
        showMessage('快进/快退: 2秒');
    } else if (e.key === '5' && video) {
        seekAmount = 5;
        showMessage('快进/快退: 5秒');
    } else if (e.key === '0' && video) {
        seekAmount = 10;
        showMessage('快进/快退: 10秒');
    }
});

// 松开按键时停止快进快退
document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const video = document.getElementById('current-video');

        if (seekInterval) {
            clearInterval(seekInterval);
            clearTimeout(seekInterval);
            seekInterval = null;
            seekSpeed = 1;
        }

        // 如果不是长按（单击），直接跳转5秒
        if (!isLongPress && video && isVideoHovered) {
            const direction = e.key === 'ArrowLeft' ? -1 : 1;
            const newTime = Math.max(0, Math.min(video.duration, video.currentTime + seekAmount * direction));
            video.currentTime = newTime;
            updateSeekIndicator(video, direction, 1);
        }

        // 延迟隐藏指示器
        if (seekIndicatorElement) {
            clearTimeout(hideIndicatorTimeout);
            hideIndicatorTimeout = setTimeout(() => {
                if (seekIndicatorElement) {
                    seekIndicatorElement.style.opacity = '0';
                    setTimeout(() => {
                        if (seekIndicatorElement) {
                            seekIndicatorElement.remove();
                            seekIndicatorElement = null;
                        }
                    }, 300);
                }
            }, 500); // 0.5秒后隐藏
        }

        isLongPress = false;
    }
});

/** 流畅快进快退：每50ms调用一次，根据按住时长自动加速 */
function seekVideoSmooth(video, direction) {
    // 根据速度倍数计算实际跳转量
    // 50ms间隔，所以基础单位是 seekAmount / 20（因为1秒=1000ms，50ms更新一次，1000/50=20）
    const actualSeekAmount = (seekAmount / 10) * seekSpeed * direction; // 每50ms跳转的秒数
    const newTime = Math.max(0, Math.min(video.duration, video.currentTime + actualSeekAmount));
    video.currentTime = newTime;
    updateSeekIndicator(video, direction, seekSpeed);
}

/** 更新快进快退指示器（显示方向、当前时间、速度倍数） */
function updateSeekIndicator(video, direction, speed) {
    const currentTime = formatTime(video.currentTime);
    const totalTime = formatTime(video.duration);
    const arrow = direction > 0 ? '→' : '←';
    const speedText = speed > 1 ? ` ×${speed}` : '';

    if (!seekIndicatorElement) {
        seekIndicatorElement = document.createElement('div');
        seekIndicatorElement.className = 'seek-indicator';
        const content = document.getElementById('lightbox-content');
        content.appendChild(seekIndicatorElement);
    }

    seekIndicatorElement.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
            <span style="font-size: 1.8rem;">${arrow}</span>
            <span style="font-size: 1.1rem; font-weight: 700;">${currentTime} / ${totalTime}</span>
            ${speedText ? `<span style="font-size: 0.9rem; color: rgba(255, 255, 255, 0.85); margin-left: 4px;">${speedText}</span>` : ''}
        </div>
    `;

    seekIndicatorElement.style.cssText = `
        position: absolute;
        top: 20%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.25);
        backdrop-filter: blur(15px);
        color: white;
        padding: 12px 20px;
        border-radius: 10px;
        font-weight: 500;
        pointer-events: none;
        z-index: 10003;
        border: 1px solid rgba(255, 255, 255, 0.06);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        text-align: center;
        opacity: 1;
        transition: opacity 0.3s ease;
    `;

    // 清除之前的隐藏定时器
    clearTimeout(hideIndicatorTimeout);
}

/** 格式化时间（秒 → "m:ss" 格式） */
function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** 显示顶部消息提示（1.5秒后自动消失） */
function showMessage(text) {
    const msg = document.createElement('div');
    msg.textContent = text;
    msg.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
        color: white;
        padding: 12px 24px;
        border-radius: 24px;
        font-size: 0.9rem;
        font-weight: 600;
        z-index: 10004;
        border: 1px solid rgba(255, 255, 255, 0.2);
    `;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 1500);
}


// ==================== 日期导航模块 ====================

/**
 * 创建日期导航面板
 * 收集所有日期分隔符，按年份分组显示，支持折叠/展开、点击跳转、图片预览
 * 打开时自动定位到当前可见日期，并展开对应年份
 */
function createDateNavigation() {
    const serviceDates = document.querySelectorAll('.message.service');
    const dates = [];
    const allMessages = document.querySelectorAll('.message.default');

    serviceDates.forEach((serviceMsg, index) => {
        const dateElement = serviceMsg.querySelector('.body.details');
        if (dateElement) {
            const dateText = dateElement.textContent.trim();
            const dateAttr = dateElement.getAttribute('data-date');
            if (dateAttr) {
                // 统计该日期下的消息数量和内容预览
                const nextServiceMsg = serviceDates[index + 1];
                let messageCount = 0;
                let previewText = '';
                let previewImage = '';

                // 遍历该日期下的所有消息
                let currentElement = serviceMsg.nextElementSibling;
                while (currentElement && currentElement !== nextServiceMsg) {
                    if (currentElement.classList.contains('message') &&
                        currentElement.classList.contains('default')) {
                        messageCount++;

                        // 获取第一条消息的文本作为预览
                        if (!previewText) {
                            const textElement = currentElement.querySelector('.text');
                            if (textElement) {
                                previewText = textElement.textContent.trim();
                            }
                        }

                        // 获取第一张图片作为预览
                        if (!previewImage) {
                            const imgElement = currentElement.querySelector('.media_wrap img');
                            if (imgElement && imgElement.src) {
                                previewImage = imgElement.src;
                            }
                        }
                    }
                    currentElement = currentElement.nextElementSibling;
                }

                dates.push({
                    text: dateText,
                    date: dateAttr,
                    element: serviceMsg,
                    count: messageCount,
                    preview: previewText,
                    previewImage: previewImage
                });
            }
        }
    });

    if (dates.length === 0) return;

    // 创建导航容器
    const nav = document.createElement('div');
    nav.id = 'date-navigation';
    nav.innerHTML = `
        <div class="date-nav-toggle">
            <span class="date-nav-icon">📅</span>
            <span class="date-nav-text">日期导航</span>
        </div>
        <div class="date-nav-content">
            <div class="date-nav-header">📆 选择日期快速跳转</div>
            <div class="date-list"></div>
        </div>
    `;

    document.body.appendChild(nav);

    // 按年分组日期
    const datesByYear = {};
    dates.forEach(dateInfo => {
        // 从日期文本中提取年份（假设格式包含年份）
        const yearMatch = dateInfo.text.match(/(\d{4})/);
        const year = yearMatch ? yearMatch[1] : '未知年份';

        if (!datesByYear[year]) {
            datesByYear[year] = [];
        }
        datesByYear[year].push(dateInfo);
    });

    // 填充日期列表（按年分组）
    const dateList = nav.querySelector('.date-list');
    const years = Object.keys(datesByYear).sort((a, b) => a - b); // 正序排列（从旧到新）

    years.forEach(year => {
        // 创建年份标题
        const yearHeader = document.createElement('div');
        yearHeader.className = 'year-header collapsed'; // 默认折叠
        yearHeader.setAttribute('data-year', year); // 添加年份数据属性
        yearHeader.innerHTML = `
            <span class="year-title">${year}</span>
            <span class="year-toggle">▼</span>
        `;
        dateList.appendChild(yearHeader);

        // 创建年份内容容器
        const yearContent = document.createElement('div');
        yearContent.className = 'year-content collapsed'; // 默认折叠
        yearContent.style.display = 'none'; // 折叠状态下隐藏
        dateList.appendChild(yearContent);

        // 年份标题点击折叠/展开
        yearHeader.addEventListener('click', () => {
            // 正确的折叠/展开切换逻辑
            const isCollapsing = !yearHeader.classList.contains('collapsed');
            yearHeader.classList.toggle('collapsed');
            yearContent.classList.toggle('collapsed');

            // 更新箭头图标
            const toggleIcon = yearHeader.querySelector('.year-toggle');
            if (toggleIcon) {
                toggleIcon.textContent = yearHeader.classList.contains('collapsed') ? '▶' : '▼';
            }

            // 使用统一的动画处理函数
            handleYearAnimation(yearHeader, yearContent, !isCollapsing); // !isCollapsing = 是否展开
        });

        // 创建该年份下的日期项
        datesByYear[year].forEach((dateInfo, index) => {
            const dateItem = document.createElement('div');
            dateItem.className = 'date-item';

            // 移动端：内嵌缩略图；PC端：hover浮层
            const isMobile = window.innerWidth <= 768;
            const thumbnailHtml = (isMobile && dateInfo.previewImage)
                ? `<div class="date-item-thumbnail"><img src="${dateInfo.previewImage}" alt="预览"></div>`
                : '';

            // 创建日期项的HTML结构
            dateItem.innerHTML = `
                ${thumbnailHtml}
                <div class="date-item-info">
                    <div class="date-item-header">
                        <span class="date-item-title">${dateInfo.text}</span>
                        <span class="date-item-count">${dateInfo.count} 条</span>
                    </div>
                    ${dateInfo.preview ? `<div class="date-item-preview">${dateInfo.preview}</div>` : ''}
                </div>
            `;

            dateItem.addEventListener('click', () => {
                scrollToDate(dateInfo.element);
                // 移动端自动关闭
                if (window.innerWidth <= 768) {
                    // 清除所有日期卡片的高亮动画
                    const allDateItems = nav.querySelectorAll('.date-item.locating');
                    allDateItems.forEach(item => clearDateHighlight(item));
                    
                    nav.classList.add('closing');
                    setTimeout(() => {
                        nav.classList.remove('active');
                        nav.classList.remove('closing');
                    }, 250);
                }
            });

            // PC端：鼠标悬停显示图片预览浮层
            if (dateInfo.previewImage && !isMobile) {
                dateItem.addEventListener('mouseenter', (e) => {
                    showImagePreview(dateInfo.previewImage, dateItem);
                });

                dateItem.addEventListener('mouseleave', () => {
                    hideImagePreview();
                });
            }

            yearContent.appendChild(dateItem);
        });
    });

    // 切换导航显示
    const toggle = nav.querySelector('.date-nav-toggle');
    const content = nav.querySelector('.date-nav-content');

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpening = !nav.classList.contains('active');
        
        if (isOpening) {
            nav.classList.remove('closing');
            nav.classList.add('active');
        } else {
            // 关闭时清除所有日期卡片的高亮动画
            const allDateItems = nav.querySelectorAll('.date-item.locating');
            allDateItems.forEach(item => clearDateHighlight(item));
            
            // 关闭时添加closing类触发动画
            nav.classList.add('closing');
            setTimeout(() => {
                nav.classList.remove('active');
                nav.classList.remove('closing');
            }, 250);
        }

        // 打开时自动定位到当前可见的日期
        if (isOpening) {
            setTimeout(() => {
                // 完全重写：修复年份默认折叠导致无法自动定位到当前日期的问题
                if (!dates.length) return;

                // 获取当前视口中间位置
                const viewportMiddle = window.scrollY + window.innerHeight / 2;

                // 找到最接近视口中间的日期
                let closestIndex = 0;
                let minDistance = Infinity;

                dates.forEach((dateInfo, index) => {
                    const rect = dateInfo.element.getBoundingClientRect();
                    const elementTop = rect.top + window.scrollY;
                    const distance = Math.abs(elementTop - viewportMiddle);

                    if (distance < minDistance) {
                        minDistance = distance;
                        closestIndex = index;
                    }
                });

                // 获取对应的日期项
                const dateItems = dateList.querySelectorAll('.date-item');

                if (dateItems[closestIndex]) {
                    // 获取当前日期的文本
                    const dateText = dateItems[closestIndex].querySelector('.date-item-title').textContent;

                    // 从日期文本中提取年份
                    const yearMatch = dateText.match(/(\d{4})/);
                    const year = yearMatch ? yearMatch[1] : '';

                    // 先折叠所有年份
                    const allYearHeaders = dateList.querySelectorAll('.year-header');
                    allYearHeaders.forEach(header => {
                        const content = header.nextElementSibling;
                        if (content && content.classList.contains('year-content')) {
                            header.classList.add('collapsed');
                            content.classList.add('collapsed');
                            content.style.display = 'none';
                            content.style.maxHeight = '0';
                            content.style.opacity = '0';
                            content.style.marginBottom = '0';
                            const toggleIcon = header.querySelector('.year-toggle');
                            if (toggleIcon) {
                                toggleIcon.textContent = '▶';
                            }
                        }
                    });

                    // 找到对应的年份标题并展开
                    if (year) {
                        const yearHeader = dateList.querySelector(`.year-header[data-year="${year}"]`);
                        if (yearHeader) {
                            const yearContent = yearHeader.nextElementSibling;
                            if (yearContent && yearContent.classList.contains('year-content')) {
                                yearHeader.classList.remove('collapsed');
                                yearContent.classList.remove('collapsed');
                                yearContent.style.display = 'block';
                                yearContent.style.maxHeight = 'none';
                                yearContent.style.opacity = '1';
                                yearContent.style.marginBottom = '8px';

                                // 更新箭头图标
                                const toggleIcon = yearHeader.querySelector('.year-toggle');
                                if (toggleIcon) {
                                    toggleIcon.textContent = '▼';
                                }

                                // 立即滚动到对应位置
                                dateItems[closestIndex].scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'center'
                                });

                                // 添加高亮效果
                                createDateHighlight(dateItems[closestIndex]);

                                // 更新置顶状态
                                setTimeout(() => {
                                    updateStickyYear();
                                }, 400);
                            }
                        }
                    }
                }
            }, 100);
        }
    });

    // 点击面板外部关闭
    document.addEventListener('click', (e) => {
        if (nav.classList.contains('active')) {
            // 如果点击的不是导航按钮也不是内容面板
            if (!nav.contains(e.target)) {
                // 清除所有日期卡片的高亮动画
                const allDateItems = nav.querySelectorAll('.date-item.locating');
                allDateItems.forEach(item => clearDateHighlight(item));
                
                nav.classList.add('closing');
                setTimeout(() => {
                    nav.classList.remove('active');
                    nav.classList.remove('closing');
                }, 250);
            }
        }
    });

    // 阻止内容面板的点击事件冒泡
    content.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // 年份标题置顶功能 - 以标题区间判定当前年份
    function updateStickyYear() {
        const dateList = nav.querySelector('.date-list');
        if (!dateList) return;

        const yearHeaders = Array.from(dateList.querySelectorAll('.year-header'));
        yearHeaders.forEach(header => header.classList.remove('sticky'));

        const expandedHeaders = yearHeaders.filter(header => {
            const yearContent = header.nextElementSibling;
            return yearContent && !yearContent.classList.contains('collapsed');
        });

        if (expandedHeaders.length === 0) return;

        const scrollPos = dateList.scrollTop + 1;
        let activeHeader = null;

        for (let i = 0; i < yearHeaders.length; i += 1) {
            const header = yearHeaders[i];
            if (header.classList.contains('collapsed')) continue;

            const headerTop = header.offsetTop;
            const nextHeaderTop = i + 1 < yearHeaders.length
                ? yearHeaders[i + 1].offsetTop
                : dateList.scrollHeight;

            if (scrollPos >= headerTop && scrollPos < nextHeaderTop) {
                activeHeader = header;
                break;
            }
        }

        if (!activeHeader) {
            for (let i = expandedHeaders.length - 1; i >= 0; i -= 1) {
                if (expandedHeaders[i].offsetTop <= scrollPos) {
                    activeHeader = expandedHeaders[i];
                    break;
                }
            }
        }

        const finalHeader = activeHeader || expandedHeaders[0];
        if (finalHeader) {
            finalHeader.classList.add('sticky');
        }
    }

    // 监听年份点击事件
    const yearHeaders = nav.querySelectorAll('.year-header');
    yearHeaders.forEach(header => {
        header.addEventListener('click', () => {
            setTimeout(updateStickyYear, 100);
        });
    });

    // 监听导航面板滚动事件
    const dateListEl = nav.querySelector('.date-list');
    if (dateListEl) {
        dateListEl.addEventListener('scroll', updateStickyYear);

        // 滚动隔离：防止面板内滚动穿透到背景页面
        dateListEl.addEventListener('wheel', function(e) {
            const scrollTop = this.scrollTop;
            const scrollHeight = this.scrollHeight;
            const clientHeight = this.clientHeight;
            const deltaY = e.deltaY;

            // 添加1像素容差，解决浮点精度问题
            const canScrollUp = scrollTop > 1;
            const canScrollDown = scrollTop + clientHeight < scrollHeight - 1;

            // 向上滚动且已在顶部，或向下滚动且已在底部时，阻止事件
            if ((deltaY < 0 && !canScrollUp) || (deltaY > 0 && !canScrollDown)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { passive: false });
    }
}

// ==================== 图片预览模块 ====================

let imagePreviewElement = null;  // 图片预览浮层DOM元素
let imageHideTimeout = null;     // 预览隐藏定时器

/** 显示图片预览浮层（定位在日期卡片旁边，自动适应屏幕边界） */
function showImagePreview(imageSrc, dateItem) {
    // 清除之前的隐藏定时器
    if (imageHideTimeout) {
        clearTimeout(imageHideTimeout);
        imageHideTimeout = null;
    }

    // 创建预览元素（如果不存在）
    if (!imagePreviewElement) {
        imagePreviewElement = document.createElement('div');
        imagePreviewElement.className = 'image-preview-tooltip';
        document.body.appendChild(imagePreviewElement);

        // 鼠标进入预览框时保持显示
        imagePreviewElement.addEventListener('mouseenter', () => {
            if (imageHideTimeout) {
                clearTimeout(imageHideTimeout);
                imageHideTimeout = null;
            }
        });

        // 鼠标离开预览框时隐藏
        imagePreviewElement.addEventListener('mouseleave', () => {
            hideImagePreview();
        });
    }

    // 设置图片
    imagePreviewElement.innerHTML = `<img src="${imageSrc}" alt="预览图">`;
    imagePreviewElement.style.display = 'block';

    // 定位到日期项旁边
    const rect = dateItem.getBoundingClientRect();
    const previewWidth = 200;
    const previewHeight = 200;

    // 默认显示在左侧
    let left = rect.left - previewWidth - 16;
    let top = rect.top + (rect.height - previewHeight) / 2;

    // 如果左侧空间不够，显示在右侧
    if (left < 10) {
        left = rect.right + 16;
    }

    // 确保不超出视口
    if (top < 10) top = 10;
    if (top + previewHeight > window.innerHeight - 10) {
        top = window.innerHeight - previewHeight - 10;
    }

    imagePreviewElement.style.left = left + 'px';
    imagePreviewElement.style.top = top + 'px';

    // 添加淡入动画
    setTimeout(() => {
        if (imagePreviewElement) {
            imagePreviewElement.classList.add('visible');
        }
    }, 10);
}

/** 延迟隐藏图片预览浮层（200ms延迟，给用户时间移动鼠标到预览框） */
function hideImagePreview() {
    // 延迟200ms隐藏，给用户时间移动鼠标到预览框
    imageHideTimeout = setTimeout(() => {
        if (imagePreviewElement) {
            imagePreviewElement.classList.remove('visible');
            setTimeout(() => {
                if (imagePreviewElement) {
                    imagePreviewElement.style.display = 'none';
                }
            }, 200);
        }
    }, 200);
}

/**
 * 统一的年份折叠/展开动画处理
 * 展开：容器淡入 + 日期卡片错开滑入
 * 折叠：日期卡片先淡出，然后容器收缩
 */
function handleYearAnimation(yearHeader, yearContent, isExpanding) {
    if (isExpanding) {
        // 展开动画：先测量实际高度，用精确值做过渡，避免maxHeight过大导致动画失真
        if (yearContent.style.display === 'none') {
            yearContent.style.display = 'block';
        }

        // 先设为初始折叠状态
        yearContent.style.transition = 'none';
        yearContent.style.maxHeight = '0';
        yearContent.style.opacity = '0';
        yearContent.style.marginBottom = '0';
        yearContent.offsetHeight; // 强制重排

        // 测量实际内容高度
        yearContent.style.maxHeight = 'none';
        const actualHeight = yearContent.scrollHeight;
        yearContent.style.maxHeight = '0';
        yearContent.offsetHeight; // 再次强制重排

        // 启动过渡动画到精确高度
        yearContent.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease, margin-bottom 0.3s ease';
        requestAnimationFrame(() => {
            yearContent.style.maxHeight = actualHeight + 'px';
            yearContent.style.opacity = '1';
            yearContent.style.marginBottom = '8px';
        });

        // 动画结束后移除固定高度限制，允许内容自由伸缩
        setTimeout(() => {
            if (!yearContent.classList.contains('collapsed')) {
                yearContent.style.transition = 'none';
                yearContent.style.maxHeight = 'none';
            }
        }, 420);
    } else {
        // 折叠动画：先锁定当前高度，再过渡到0
        const actualHeight = yearContent.scrollHeight;
        yearContent.style.transition = 'none';
        yearContent.style.maxHeight = actualHeight + 'px';
        yearContent.offsetHeight; // 强制重排，锁定当前高度

        // 启动收缩过渡
        yearContent.style.transition = 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease, margin-bottom 0.25s ease';
        requestAnimationFrame(() => {
            yearContent.style.maxHeight = '0';
            yearContent.style.opacity = '0';
            yearContent.style.marginBottom = '0';
        });

        // 动画结束后清理
        setTimeout(() => {
            if (yearContent.classList.contains('collapsed')) {
                yearContent.style.display = 'none';
            }
        }, 320);
    }
}

/**
 * 滚动到指定日期并播放定位动画
 * 如果对应年份未展开，会先自动展开再滚动
 */
function scrollToDate(element) {
    // 找到对应的年份标题并展开
    const yearContent = element.closest('.year-content');

    if (yearContent) {
        const yearHeader = yearContent.previousElementSibling;

        if (yearHeader && yearHeader.classList.contains('year-header')) {
            // 检查是否真的需要展开：既要检查 collapsed 类，也要检查实际的 display 状态
            const hasCollapsedClass = yearHeader.classList.contains('collapsed');
            const displayNone = yearContent.style.display === 'none';
            const maxHeightZero = yearContent.style.maxHeight === '0' || yearContent.style.maxHeight === '0px';
            const isActuallyCollapsed = hasCollapsedClass || displayNone || maxHeightZero;

            if (isActuallyCollapsed) {
                // 重置所有状态到初始折叠状态
                yearHeader.classList.remove('collapsed');
                yearContent.classList.remove('collapsed');
                yearContent.style.display = 'block';
                yearContent.style.maxHeight = '0';
                yearContent.style.opacity = '0';
                yearContent.style.marginBottom = '0';

                // 强制重排
                yearContent.offsetHeight;

                // 更新箭头图标
                const toggleIcon = yearHeader.querySelector('.year-toggle');
                if (toggleIcon) {
                    toggleIcon.textContent = '▼';
                }

                // 测量实际高度后执行展开动画
                yearContent.style.maxHeight = 'none';
                const actualHeight = yearContent.scrollHeight;
                yearContent.style.maxHeight = '0';
                yearContent.offsetHeight;

                requestAnimationFrame(() => {
                    yearContent.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease, margin-bottom 0.3s ease';
                    yearContent.style.maxHeight = actualHeight + 'px';
                    yearContent.style.opacity = '1';
                    yearContent.style.marginBottom = '8px';
                });

                // 动画结束后移除固定高度限制
                setTimeout(() => {
                    if (!yearContent.classList.contains('collapsed')) {
                        yearContent.style.transition = 'none';
                        yearContent.style.maxHeight = 'none';
                    }
                }, 420);
            }
        }
    }

    // 等待展开动画完成后直接滚动并添加定位动画
    setTimeout(() => {
        const elementTop = element.getBoundingClientRect().top + window.scrollY;
        const offset = 100;
        const targetPosition = elementTop - offset;

        // 直接平滑滚动，不使用弹性动画
        window.scrollTo({
            top: targetPosition,
            behavior: 'smooth'
        });

        // 滚动完成后添加定位动画
        setTimeout(() => {
            createDateHighlight(element);
        }, 300);
    }, 100);
}

/**
 * 创建日期定位动画（边框闪烁跳动 + 竖线装饰 + 横线脉冲，1.5s）
 * 打断重定位时会先彻底清除旧动画再重新播放，保证完整的两次脉冲
 * 日期行（.message.service）会添加左右竖线装饰元素
 * 日期卡片（.date-item）只添加动画类名
 */
function createDateHighlight(element) {
    // 先彻底清除旧动画（包括竖线元素和定时器），防止打断后动画丢失
    clearDateHighlight(element);
    // 强制重排，确保移除类名后浏览器已完成渲染，再添加类名才能重新触发动画
    void element.offsetWidth;
    element.classList.add('locating');

    // 日期行（.message.service）添加左右短竖线装饰元素
    if (element.classList.contains('service')) {
        const leftLine = document.createElement('div');
        leftLine.className = 'date-line-left';
        const rightLine = document.createElement('div');
        rightLine.className = 'date-line-right';
        element.appendChild(leftLine);
        element.appendChild(rightLine);

        const timerId = setTimeout(() => {
            element.classList.remove('locating');
            leftLine.remove();
            rightLine.remove();
        }, 1600);
        element._highlightTimer = timerId;
    } else {
        // 日期导航面板中的卡片：动画结束后直接移除类名（参考V3/10，动画无forwards自然回到默认样式）
        const timerId = setTimeout(() => {
            element.classList.remove('locating');
        }, 1600);
        element._highlightTimer = timerId;
    }
}

/** 清除日期高亮动画（同时移除竖线装饰元素和定时器） */
function clearDateHighlight(element) {
    element.classList.remove('locating');
    const leftLine = element.querySelector('.date-line-left');
    const rightLine = element.querySelector('.date-line-right');
    if (leftLine) leftLine.remove();
    if (rightLine) rightLine.remove();
    if (element._highlightTimer) {
        clearTimeout(element._highlightTimer);
        element._highlightTimer = null;
    }
}

// ==================== Open Graph链接预览模块 ====================

/**
 * 初始化链接预览：扫描消息中的外部链接，生成预览卡片
 * 跳过Telegram内部链接（t.me、telegram.），隐藏原始链接文本
 * 先显示基础预览，然后异步获取Open Graph元数据更新
 */
async function initLinkPreviews() {
    const textDivs = document.querySelectorAll('.text');

    for (const textDiv of textDivs) {
        const links = textDiv.querySelectorAll('a[href^="http"]');

        for (const link of links) {
            const url = link.href;

            if (url.includes('t.me/') || url.includes('telegram.')) {
                continue;
            }

            const existingPreview = link.nextElementSibling;
            if (existingPreview && existingPreview.classList.contains('link-preview-card')) {
                continue;
            }

            const previewCard = document.createElement('div');
            previewCard.className = 'link-preview-card loaded';

            const linkText = link.textContent.trim();
            try {
                const urlObj = new URL(url);
                previewCard.innerHTML = `
                    <a href="${url}" target="_blank" class="link-preview-content">
                        <div class="link-preview-info">
                            <div class="link-preview-title">${linkText}</div>
                            <div class="link-preview-url">${urlObj.hostname}</div>
                        </div>
                    </a>
                `;
            } catch (e) {
                continue;
            }

            link.parentNode.insertBefore(previewCard, link.nextSibling);
            link.style.display = 'none';

            fetchOpenGraphData(url, previewCard, link, linkText);
        }
    }
}

/**
 * 通过CORS代理获取目标URL的Open Graph元数据（标题、描述、图片）
 * 依次尝试多个代理服务，单个超时5秒自动切换下一个
 */
async function fetchOpenGraphData(url, previewCard, linkElement, originalLinkText) {
    const corsProxies = [
        { url: 'https://api.allorigins.win/get?url=', format: 'json' },
        { url: 'https://corsproxy.io/?', format: 'text' },
        { url: 'https://api.codetabs.com/v1/proxy?quest=', format: 'text' }
    ];

    for (const proxy of corsProxies) {
        try {
            const response = await fetch(proxy.url + encodeURIComponent(url), {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) continue;

            let html;
            if (proxy.format === 'json') {
                const data = await response.json();
                html = data.contents;
            } else {
                html = await response.text();
            }

            if (!html || html.length < 100) continue;

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const ogTitle = doc.querySelector('meta[property="og:title"]')?.content ||
                doc.querySelector('title')?.textContent;
            const ogImage = doc.querySelector('meta[property="og:image"]')?.content || '';
            const ogDescription = doc.querySelector('meta[property="og:description"]')?.content ||
                doc.querySelector('meta[name="description"]')?.content || '';
            const ogUrl = doc.querySelector('meta[property="og:url"]')?.content || url;

            if (!ogTitle) continue;

            previewCard.innerHTML = `
                <a href="${ogUrl}" target="_blank" class="link-preview-content">
                    ${ogImage ? `<div class="link-preview-image" style="background-image: url('${ogImage}')"></div>` : ''}
                    <div class="link-preview-info">
                        <div class="link-preview-title">${ogTitle}</div>
                        ${ogDescription ? `<div class="link-preview-description">${ogDescription}</div>` : ''}
                        <div class="link-preview-url">${new URL(ogUrl).hostname}</div>
                    </div>
                </a>
            `;

            return;

        } catch (error) {
            continue;
        }
    }
}

// Telegram原版HTML中引用的兼容函数（原版HTML中有调用，不可删除）
function CheckLocation() {}
function ShowHashtag(tag) { return false; }

// ==================== 标签导航模块 ====================

/** 标准化标签名（去空格 + 转小写，用于去重和匹配） */
function normalizeCategoryKey(tagName) {
    return (tagName || '').trim().toLowerCase();
}

/** 转义正则表达式特殊字符 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 收集所有消息中的#标签
 * 同时从 HTML（ShowHashtag函数调用）和纯文本（#标签格式）两种方式提取
 * 返回标签数据对象（含标签名、消息数量、消息列表）
 */
function collectCategories() {
    categoriesData = {};
    const messages = document.querySelectorAll('.message.default');

    messages.forEach((message) => {
        if (message.style.display === 'none') return;

        const textElement = message.querySelector('.text');
        if (!textElement) return;

        const extractedTags = new Map();

        // 获取原始HTML内容，包含换行和HTML实体
        const htmlContent = textElement.innerHTML;
        
        // 方法1：从HTML中匹配ShowHashtag，处理&quot;等HTML实体
        // 匹配 ShowHashtag(&quot;标签名&quot;) 或 ShowHashtag("标签名") 格式
        const hashtagPattern = /ShowHashtag\s*\(\s*(?:&quot;|"|')([^"'&]+)(?:&quot;|"|')\s*\)/gi;
        let match;
        while ((match = hashtagPattern.exec(htmlContent)) !== null) {
            if (match[1]) {
                const rawTagName = match[1].trim();
                const tagKey = normalizeCategoryKey(rawTagName);
                if (tagKey && !extractedTags.has(tagKey)) {
                    extractedTags.set(tagKey, rawTagName);
                }
            }
        }

        // 方法2：从纯文本中提取#标签作为补充
        const text = textElement.textContent.trim();
        if (text) {
            // 支持中文、英文、数字、下划线的标签
            const tagRegex = /#[a-zA-Z0-9_\u4e00-\u9fa5]+/gi;
            const matches = text.match(tagRegex);
            if (matches) {
                matches.forEach(tag => {
                    const rawTagName = tag.substring(1).trim();
                    const tagKey = normalizeCategoryKey(rawTagName);
                    if (tagKey && !extractedTags.has(tagKey)) {
                        extractedTags.set(tagKey, rawTagName);
                    }
                });
            }
        }

        // 保存数据
        extractedTags.forEach((displayName, tagKey) => {
            if (!categoriesData[tagKey]) {
                categoriesData[tagKey] = {
                    name: displayName,
                    count: 0,
                    messages: []
                };
            }

            categoriesData[tagKey].count++;
            categoriesData[tagKey].messages.push({
                element: message,
                text: text ? (text.substring(0, 200) + (text.length > 200 ? '...' : '')) : '',
                fullText: text || ''
            });
        });
    });

    return categoriesData;
}

/**
 * 创建标签导航面板
 * 收集所有#标签，按消息数量排序显示，支持一级标签列表和二级消息列表
 * 绑定打开/关闭动画、滚动隔离、点击外部关闭等交互
 */
function createCategoryNavigation() {
    const categories = collectCategories();
    const categoryNames = Object.keys(categories);

    // TAK：无标签时也保留入口，面板展示空状态。
    const nav = document.createElement('div');
    nav.id = 'category-navigation';
    nav.innerHTML = `
        <div class="category-nav-toggle">
            <span class="category-nav-icon">🏷️</span>
        </div>
        <div class="category-nav-overlay"></div>
        <div class="category-nav-modal">
            <div class="category-modal-header">
                <h2 class="category-modal-title">标签导航</h2>
                <button class="category-modal-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
            </div>
            <div class="category-modal-body">
                <div class="category-list-container">
                    <div class="category-list"></div>
                </div>
                <div class="category-messages-container" style="display: none;">
                    <div class="category-messages-header">
                        <div class="category-messages-header-bg"></div>
                        <div class="category-messages-header-content">
                            <button class="category-back-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> 返回</button>
                            <span class="category-title"></span>
                        </div>
                        <button class="category-messages-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                    </div>
                    <div class="category-messages-body">
                        <div class="category-messages-list"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(nav);

    const categoryList = nav.querySelector('.category-list');

    if (categoryNames.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'category-empty';
        empty.innerHTML = '<strong>暂无标签</strong><span>在消息中使用 #标签 后，这里会自动汇总</span>';
        categoryList.appendChild(empty);
    }

    const sortedCategories = categoryNames.sort((a, b) => {
        return categories[b].count - categories[a].count;
    });

    sortedCategories.forEach(categoryName => {
        const category = categories[categoryName];
        const categoryItem = document.createElement('div');
        categoryItem.className = 'category-item';
        categoryItem.setAttribute('data-category', categoryName);
        categoryItem.innerHTML = `
            <div class="category-item-content">
                <span class="category-name">#${category.name}</span>
                <span class="category-count">${category.count}</span>
            </div>
        `;

        categoryItem.addEventListener('click', () => {
            showCategoryMessages(categoryName, categoryItem);
        });

        categoryList.appendChild(categoryItem);
    });

    const toggle = nav.querySelector('.category-nav-toggle');
    const overlay = nav.querySelector('.category-nav-overlay');
    const modal = nav.querySelector('.category-nav-modal');
    const closeBtn = nav.querySelector('.category-modal-close');

    /** 给标签气泡添加按行批量淡入上移入场动画（同一行同时出现，每行间隔50ms） */
    function animateCategoryBubbles() {
        const categoryListPanel = nav.querySelector('.category-list-container');
        if (!categoryListPanel) return;
        const items = categoryListPanel.querySelectorAll('.category-item');
        if (items.length === 0) return;
        items.forEach((item) => {
            item.style.opacity = '0';
            item.style.transform = 'translateY(8px)';
            item.style.transition = 'none';
        });
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // 按行分组：用offsetTop判断同一行
                const rowDelay = 50;
                let currentRowTop = -1;
                let rowIndex = -1;
                items.forEach((item) => {
                    const top = item.offsetTop;
                    if (top !== currentRowTop) {
                        currentRowTop = top;
                        rowIndex++;
                    }
                    const delay = rowIndex * rowDelay;
                    item.style.transition = `opacity 0.2s ease ${delay}ms, transform 0.2s ease ${delay}ms`;
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                });
                const totalDuration = rowIndex * rowDelay + 220;
                setTimeout(() => {
                    items.forEach((item) => {
                        item.style.transition = '';
                        item.style.opacity = '';
                        item.style.transform = '';
                    });
                }, totalDuration);
            });
        });
    }

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpening = !nav.classList.contains('active');
        
        if (isOpening) {
            nav.classList.remove('closing');
            nav.classList.add('active');
            animateCategoryBubbles();
        } else {
            nav.classList.add('closing');
            setTimeout(() => {
                nav.classList.remove('active');
                nav.classList.remove('closing');
            }, 350);
        }
    });

    const closeCategoryNav = () => {
        nav.classList.add('closing');
        setTimeout(() => {
            nav.classList.remove('active');
            nav.classList.remove('closing');
        }, 250);
    };

    overlay.addEventListener('click', closeCategoryNav);

    closeBtn.addEventListener('click', closeCategoryNav);

    modal.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // 为一级面板添加滚动隔离
    const modalBody = nav.querySelector('.category-modal-body');
    if (modalBody) {
        modalBody.addEventListener('wheel', function(e) {
            // 检查事件目标是否是一级面板内的元素（不是二级面板）
            const messagesPanel = nav.querySelector('.category-messages-container');
            if (messagesPanel && messagesPanel.style.display !== 'none') {
                // 如果二级面板显示中，不处理一级面板的事件
                return;
            }
            
            const canScrollUp = this.scrollTop > 0;
            const canScrollDown = this.scrollTop + this.clientHeight < this.scrollHeight;
            
            if ((e.deltaY < 0 && !canScrollUp) || (e.deltaY > 0 && !canScrollDown)) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    document.addEventListener('click', (e) => {
        if (nav.classList.contains('active') && !nav.contains(e.target)) {
            nav.classList.add('closing');
            setTimeout(() => {
                nav.classList.remove('active');
                nav.classList.remove('closing');
            }, 250);
        }
    });

    const backBtn = nav.querySelector('.category-back-btn');
    backBtn.addEventListener('click', () => {
        hideCategoryMessages();
    });

    enhanceHashtagsInMessages();
}

/**
 * 显示指定标签下的消息列表（二级面板）
 * 生成消息预览卡片，高亮当前标签，支持点击跳转到原消息位置
 */
function showCategoryMessages(categoryName, categoryItem) {
    currentCategory = categoryName;
    const nav = document.getElementById('category-navigation');
    const messagesPanel = nav.querySelector('.category-messages-container');
    const categoryListPanel = nav.querySelector('.category-list-container');
    const categoryTitle = nav.querySelector('.category-title');
    const messagesList = nav.querySelector('.category-messages-list');

    const category = categoriesData[categoryName];
    if (!category) return;

    categoryTitle.textContent = `#${category.name}`;
    messagesList.innerHTML = '';

    category.messages.forEach((msgData, index) => {
        const messageItem = document.createElement('div');
        messageItem.className = 'category-message-item';
        messageItem.setAttribute('data-index', index);

        const imgElement = msgData.element.querySelector('.media_wrap img');
        const imgSrc = imgElement ? imgElement.src : '';
        
        // 获取消息的原始HTML内容，保留<br>换行
        const textElement = msgData.element.querySelector('.text');
        let messageHTML = textElement ? textElement.innerHTML : '';

        // 移除所有<a>标签但保留其文本内容（标签名）
        messageHTML = messageHTML.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');

        // 过滤掉空白行（连续的<br>或只有空格的行）
        messageHTML = messageHTML.replace(/(<br>\s*){2,}/gi, '<br>');
        messageHTML = messageHTML.replace(/<br>\s*<br>/gi, '<br>');
        // 过滤掉</blockquote>之后的<br>空白行
        messageHTML = messageHTML.replace(/<\/blockquote>\s*<br>/gi, '</blockquote>');

        // 高亮当前标签 - 使用单词边界确保精确匹配
        if (categoryName) {
            // 匹配 #标签名（忽略大小写）并保留原文本大小写
            const tagRegex = new RegExp(`#${escapeRegExp(categoryName)}(?=<br|\\s|$|</)`, 'gi');
            messageHTML = messageHTML.replace(tagRegex, (matchedTag) => `<span class="highlight-tag">${matchedTag}</span>`);
        }

        messageItem.innerHTML = `
            ${imgSrc ? `<div class="category-message-image"><img src="${imgSrc}" alt="预览"></div>` : ''}
            <div class="category-message-content">
                <div class="category-message-preview">${messageHTML}</div>
            </div>
        `;

        messageItem.addEventListener('click', () => {
            scrollToMessage(msgData.element);
            nav.classList.remove('active');
        });

        messagesList.appendChild(messageItem);
    });

    categoryListPanel.style.display = 'none';
    // 重置可能残留的返回动画样式
    messagesPanel.style.transition = '';
    messagesPanel.style.transform = '';
    messagesPanel.style.opacity = '';
    messagesPanel.style.display = 'flex';
    
    // 重置消息列表滚动位置到顶部
    messagesList.scrollTop = 0;
    
    // 不隐藏一级面板的header，让二级面板覆盖在上面

    const messagesHeaderContent = nav.querySelector('.category-messages-header-content');
    messagesHeaderContent.innerHTML = `
        <button class="category-back-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> 返回</button>
        <span class="category-title">#${category.name}</span>
    `;

    const messagesHeader = nav.querySelector('.category-messages-header');
    const closeBtn = messagesHeader.querySelector('.category-messages-close');
    closeBtn.addEventListener('click', () => {
        const nav = document.getElementById('category-navigation');
        nav.classList.add('closing');
        setTimeout(() => {
            nav.classList.remove('active');
            nav.classList.remove('closing');
            hideCategoryMessages();
        }, 250);
    });

    const backBtn = messagesHeaderContent.querySelector('.category-back-btn');
    backBtn.addEventListener('click', () => {
        hideCategoryMessages();
    });

    // 为二级面板添加滚动隔离
    messagesList.addEventListener('wheel', function(e) {
        const scrollTop = this.scrollTop;
        const clientHeight = this.clientHeight;
        const scrollHeight = this.scrollHeight;
        const deltaY = e.deltaY;
        
        // 检查是否可以向上/向下滚动（添加容差值）
        const canScrollUp = scrollTop > 1;
        const canScrollDown = scrollTop + clientHeight < scrollHeight - 1;
        
        // 向上滚动且在顶部，或向下滚动且在底部时，阻止事件
        if ((deltaY < 0 && !canScrollUp) || (deltaY > 0 && !canScrollDown)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false });

    const messageItems = messagesList.querySelectorAll('.category-message-item');
    messageItems.forEach((item, index) => {
        setTimeout(() => {
            item.style.opacity = '1';
            item.style.transform = 'translateY(0)';
        }, index * 40);
    });
}

/** 隐藏二级消息列表，返回一级标签列表（带淡出动画） */
function hideCategoryMessages() {
    const nav = document.getElementById('category-navigation');
    const messagesPanel = nav.querySelector('.category-messages-container');
    const messagesBody = nav.querySelector('.category-messages-body');
    const messagesHeaderContent = nav.querySelector('.category-messages-header-content');
    const categoryListPanel = nav.querySelector('.category-list-container');

    // 返回动画：与进入动画对称的panelFadeOut（缩放+淡出）
    messagesBody.style.animation = 'panelFadeOut 0.2s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    if (messagesHeaderContent) {
        messagesHeaderContent.style.animation = 'contentFadeOut 0.2s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    }

    setTimeout(() => {
        messagesPanel.style.display = 'none';
        messagesPanel.style.transition = '';
        messagesPanel.style.transform = '';
        messagesPanel.style.opacity = '';
        messagesBody.style.animation = '';
        if (messagesHeaderContent) {
            messagesHeaderContent.style.animation = '';
        }
        categoryListPanel.style.display = 'flex';
        currentCategory = null;

        // 给一级面板的标签气泡加入场动画（按行批量淡入上移，双rAF确保生效）
        const categoryItems = categoryListPanel.querySelectorAll('.category-item');
        categoryItems.forEach((item) => {
            item.style.opacity = '0';
            item.style.transform = 'translateY(8px)';
            item.style.transition = 'none';
        });
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const rowDelay = 35;
                let currentRowTop = -1;
                let rowIndex = -1;
                categoryItems.forEach((item) => {
                    const top = item.offsetTop;
                    if (top !== currentRowTop) {
                        currentRowTop = top;
                        rowIndex++;
                    }
                    const delay = rowIndex * rowDelay;
                    item.style.transition = `opacity 0.2s ease ${delay}ms, transform 0.2s ease ${delay}ms`;
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                });
                const totalDuration = rowIndex * rowDelay + 220;
                setTimeout(() => {
                    categoryItems.forEach((item) => {
                        item.style.transition = '';
                        item.style.opacity = '';
                        item.style.transform = '';
                    });
                }, totalDuration);
            });
        });
    }, 200);
}

/**
 * 滚动到指定消息并播放高亮动画
 * 使用requestAnimationFrame检测滚动稳定后再触发高亮，避免动画闪烁
 */
function scrollToMessage(messageElement) {
    const elementTop = messageElement.getBoundingClientRect().top + window.scrollY;
    const offset = 120;
    const targetPosition = elementTop - offset;

    window.scrollTo({
        top: targetPosition,
        behavior: 'smooth'
    });

    // 等待平滑滚动稳定后再触发高亮，避免动画尾部出现闪烁
    if (scrollToMessage._highlightRafId) {
        cancelAnimationFrame(scrollToMessage._highlightRafId);
        scrollToMessage._highlightRafId = null;
    }

    if (scrollToMessage._highlightStartTimer) {
        clearTimeout(scrollToMessage._highlightStartTimer);
        scrollToMessage._highlightStartTimer = null;
    }

    let lastY = window.scrollY;
    let stableFrames = 0;
    let remainingFrames = 180;

    const checkScrollSettled = () => {
        const currentY = window.scrollY;
        const delta = Math.abs(currentY - lastY);

        const distanceToTarget = Math.abs(currentY - targetPosition);

        if (delta < 0.2 && distanceToTarget < 1.5) {
            stableFrames += 1;
        } else {
            stableFrames = 0;
        }

        lastY = currentY;
        remainingFrames -= 1;

        if (stableFrames >= 8 || remainingFrames <= 0) {
            scrollToMessage._highlightRafId = null;
            scrollToMessage._highlightStartTimer = setTimeout(() => {
                scrollToMessage._highlightStartTimer = null;
                createMessageHighlight(messageElement);
            }, 80);
            return;
        }

        scrollToMessage._highlightRafId = requestAnimationFrame(checkScrollSettled);
    };

    scrollToMessage._highlightRafId = requestAnimationFrame(checkScrollSettled);
}

/**
 * 创建消息定位高亮动画
 * 添加message-locating类触发CSS动画，动画结束后进入冷却期防止重复触发
 */
function createMessageHighlight(element) {
    if (element._messageHighlightTimer) {
        clearTimeout(element._messageHighlightTimer);
        element._messageHighlightTimer = null;
    }

    if (element._messageHighlightEndHandler) {
        element.removeEventListener('animationend', element._messageHighlightEndHandler);
        element._messageHighlightEndHandler = null;
    }

    const cleanup = () => {
        if (element._messageHighlightTimer) {
            clearTimeout(element._messageHighlightTimer);
            element._messageHighlightTimer = null;
        }

        if (element._messageHighlightCooldownRaf1) {
            cancelAnimationFrame(element._messageHighlightCooldownRaf1);
            element._messageHighlightCooldownRaf1 = null;
        }

        if (element._messageHighlightCooldownRaf2) {
            cancelAnimationFrame(element._messageHighlightCooldownRaf2);
            element._messageHighlightCooldownRaf2 = null;
        }

        if (element._messageHighlightEndHandler) {
            element.removeEventListener('animationend', element._messageHighlightEndHandler);
            element._messageHighlightEndHandler = null;
        }

        element.classList.remove('message-locating');
        element.classList.add('message-locating-cooldown');

        element._messageHighlightCooldownRaf1 = requestAnimationFrame(() => {
            element._messageHighlightCooldownRaf1 = null;
            element._messageHighlightCooldownRaf2 = requestAnimationFrame(() => {
                element._messageHighlightCooldownRaf2 = null;
                element.classList.remove('message-locating-cooldown');
                // 保持 inline animation:none 防止 slideIn 重新触发导致闪烁
                element.style.animation = 'none';
            });
        });
    };

    element.classList.remove('message-locating-cooldown');
    element.classList.remove('message-locating');
    // 先用 inline animation:none 阻止 slideIn 在 reflow 时触发
    element.style.animation = 'none';
    void element.offsetWidth;
    // 移除 inline style，让 .message-locating 的 !important 动画生效
    element.style.animation = '';
    element.classList.add('message-locating');

    element._messageHighlightEndHandler = (event) => {
        if (event.animationName !== 'messageLocatingPulse') {
            return;
        }
        cleanup();
    };

    element.addEventListener('animationend', element._messageHighlightEndHandler);

    // fallback：防止极端情况下 animationend 未触发
    element._messageHighlightTimer = setTimeout(cleanup, 1400);
}

/** 增强消息中的#标签：将纯文本标签转换为可点击元素，点击后打开对应标签面板 */
function enhanceHashtagsInMessages() {
    const messages = document.querySelectorAll('.message.default .text');

    messages.forEach(textElement => {
        const originalHTML = textElement.innerHTML;
        const enhancedHTML = originalHTML.replace(/#([\u4e00-\u9fa5a-zA-Z0-9_]+)/g, (match, categoryName) => {
            return `<span class="hashtag-link" data-category="${normalizeCategoryKey(categoryName)}">${match}</span>`;
        });

        if (enhancedHTML !== originalHTML) {
            textElement.innerHTML = enhancedHTML;

            const hashtags = textElement.querySelectorAll('.hashtag-link');
            hashtags.forEach(hashtag => {
                hashtag.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const categoryName = hashtag.getAttribute('data-category');
                    openCategoryPanel(categoryName);
                });
            });
        }
    });
}

/** 打开标签导航面板并直接跳转到指定标签的消息列表 */
function openCategoryPanel(categoryName) {
    const normalizedCategoryName = normalizeCategoryKey(categoryName);
    if (!normalizedCategoryName) return;

    const nav = document.getElementById('category-navigation');
    if (!nav) return;

    nav.classList.add('active');

    setTimeout(() => {
        const escapedCategoryName = (window.CSS && typeof CSS.escape === 'function')
            ? CSS.escape(normalizedCategoryName)
            : normalizedCategoryName.replace(/(["\\])/g, '\\$1');
        const categoryItem = nav.querySelector(`.category-item[data-category="${escapedCategoryName}"]`);
        if (categoryItem) {
            showCategoryMessages(normalizedCategoryName, categoryItem);
        }
    }, 100);
}

// ==================== 分页链接美化 ====================

/** 美化Telegram导出的分页链接（Previous/Next messages → 中文 + SVG箭头 + 现代化样式） */
function beautifyPagination() {
    // SVG箭头：左箭头和右箭头（精心设计的圆角chevron）
    const svgLeft = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
    const svgRight = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

    const paginationLinks = document.querySelectorAll('a.pagination.block_link');
    paginationLinks.forEach(link => {
        const text = link.textContent.trim().toLowerCase();
        const isNext = text.includes('next');
        const isPrev = text.includes('previous');
        if (!isNext && !isPrev) return;

        link.className = 'pagination-beautified';
        link.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'pagination-inner';

        const arrow = document.createElement('span');
        arrow.className = 'pagination-arrow ' + (isPrev ? 'arrow-left' : 'arrow-right');
        arrow.innerHTML = isPrev ? svgLeft : svgRight;

        const label = document.createElement('span');
        label.className = 'pagination-label';
        label.textContent = isPrev ? '查看更早的消息' : '查看更多消息';

        if (isPrev) {
            inner.appendChild(arrow);
            inner.appendChild(label);
        } else {
            inner.appendChild(label);
            inner.appendChild(arrow);
        }
        link.appendChild(inner);
    });
}

// ==================== 网页标题替换 ====================

/** 从页面header中提取聊天对象名称替换默认的"Exported Data"标题 */
function updatePageTitle() {
    const titleEl = document.querySelector('.page_header .content .text.bold');
    if (titleEl) {
        const name = titleEl.textContent.trim();
        if (name) {
            document.title = name;
        }
    }
}

// ==================== 滚动按钮 ====================

/** 创建一键滚动至顶部/底部按钮，PC端和移动端差异化设计 */
function createScrollButtons() {
    const container = document.createElement('div');
    container.className = 'scroll-buttons';

    const isMobile = isMobileDevice();

    // 顶部按钮
    const topBtn = document.createElement('button');
    topBtn.className = 'scroll-btn scroll-top-btn';
    topBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
    if (!isMobile) {
        const topLabel = document.createElement('span');
        topLabel.className = 'scroll-btn-label';
        topLabel.textContent = '顶部';
        topBtn.appendChild(topLabel);
    }
    topBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 底部按钮
    const bottomBtn = document.createElement('button');
    bottomBtn.className = 'scroll-btn scroll-bottom-btn';
    bottomBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    if (!isMobile) {
        const bottomLabel = document.createElement('span');
        bottomLabel.className = 'scroll-btn-label';
        bottomLabel.textContent = '底部';
        bottomBtn.appendChild(bottomLabel);
    }
    bottomBtn.addEventListener('click', () => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });

    container.appendChild(topBtn);
    container.appendChild(bottomBtn);
    document.body.appendChild(container);

    // 滚动监听：根据滚动位置显隐按钮
    let scrollTimer = null;
    const updateVisibility = () => {
        const scrollTop = window.scrollY;
        const scrollHeight = document.documentElement.scrollHeight;
        const clientHeight = window.innerHeight;
        const atTop = scrollTop < 200;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 200;

        topBtn.classList.toggle('visible', !atTop);
        bottomBtn.classList.toggle('visible', !atBottom);
    };

    window.addEventListener('scroll', () => {
        if (scrollTimer) cancelAnimationFrame(scrollTimer);
        scrollTimer = requestAnimationFrame(updateVisibility);
    }, { passive: true });

    // 初始检测
    updateVisibility();
}

// ==================== 网页图标 ====================

/** 添加Telegram风格的SVG favicon */
function addFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;

    const svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs><linearGradient id="tg" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#37aee2"/><stop offset="1" stop-color="#1e96c8"/></linearGradient></defs><circle cx="120" cy="120" r="120" fill="url(#tg)"/><path d="M98 175c-3.9 0-3.2-1.5-4.6-5.2L82 132.2 170.4 78" fill="#c8daea"/><path d="M98 175c3 0 4.3-1.4 6-3l16-15.6-20-12" fill="#a9c9dd"/><path d="M100 144.4l48.4 35.7c5.5 3 9.5 1.5 10.9-5.1l19.7-92.8c2-8.1-3.1-11.7-8.4-9.3L66 117.5c-7.9 3.2-7.8 7.6-1.4 9.5l29.7 9.3L163 83c3.2-2 6.2-.9 3.8 1.3" fill="#fff"/></svg>';

    const blob = new Blob([svgIcon], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = url;
    document.head.appendChild(link);
}
