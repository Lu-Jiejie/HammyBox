/* ======== 文件读取工具函数 ======== */

// 判断请求域名是否在允许的域名列表中
export function isDomainAllowed(context) {
    const { securityConfig, Referer } = context;

    // 如果配置里禁用了域名过滤，直接通过
    if (!securityConfig?.access?.refererCheck?.enabled) {
        return true;
    }

    const refererCheckConfig = securityConfig.access.refererCheck;
    const allowedDomains = refererCheckConfig.allowedDomains || [];
    const allowEmptyReferer = refererCheckConfig.allowEmptyReferer ?? true;

    // 空 Referer 处理
    if (!Referer) {
        return allowEmptyReferer;
    }

    // 解析 Referer 域名
    try {
        const refererUrl = new URL(Referer);
        const refererHost = refererUrl.hostname;

        // 检查白名单（支持完全匹配和子域名匹配）
        const isAllowed = allowedDomains.some(domain => {
            // 完全匹配
            if (refererHost === domain) {
                return true;
            }
            // 子域名匹配（例如：a.example.com 匹配 example.com）
            if (refererHost.endsWith(`.${domain}`)) {
                return true;
            }
            return false;
        });

        return isAllowed;
    } catch (e) {
        // Referer 格式错误，拒绝访问
        console.error('Invalid Referer format:', Referer, e);
        return false;
    }
}

// 判断请求是否来自公开图库页面 (/browse 或 /browse/*)
export function isFromPublicBrowse(Referer, origin) {
    if (!Referer) return false;
    try {
        const refererUrl = new URL(Referer);
        // 检查是否来自同源的 /browse 或 /browse/* 路径
        if (refererUrl.origin === origin) {
            const pathname = refererUrl.pathname;
            if (pathname === '/browse' || pathname.startsWith('/browse/')) {
                return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

export const FILE_CACHE_CONTROL = {
    PUBLIC: 'public, max-age=2592000',
    PRIVATE: 'private, max-age=86400',
    NO_STORE: 'private, no-store, max-age=0',
};

// 公共响应头设置函数
export function setCommonHeaders(headers, encodedFileName, fileType, cacheControl = FILE_CACHE_CONTROL.PUBLIC) {
    headers.set('Content-Disposition', `inline; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Vary', 'Range');

    if (fileType) {
        headers.set('Content-Type', fileType);
    }

    headers.set('Cache-Control', cacheControl || FILE_CACHE_CONTROL.PUBLIC);
}

// 设置Range请求相关头部
export function setRangeHeaders(headers, rangeStart, rangeEnd, totalSize) {
    const contentLength = rangeEnd - rangeStart + 1;
    headers.set('Content-Length', contentLength.toString());
    headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
}

// 处理HEAD请求的公共函数
export function handleHeadRequest(headers, etag = null) {
    const responseHeaders = new Headers();

    // 复制关键头部
    responseHeaders.set('Content-Length', headers.get('Content-Length') || '0');
    responseHeaders.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
    responseHeaders.set('Content-Disposition', headers.get('Content-Disposition') || 'inline');
    responseHeaders.set('Access-Control-Allow-Origin', headers.get('Access-Control-Allow-Origin') || '*');
    responseHeaders.set('Accept-Ranges', headers.get('Accept-Ranges') || 'bytes');
    responseHeaders.set('Cache-Control', headers.get('Cache-Control') || 'public, max-age=2592000');

    if (etag) {
        responseHeaders.set('ETag', etag);
    }

    return new Response(null, {
        status: 200,
        headers: responseHeaders,
    });
}

export async function getFileContent(request, targetUrl, max_retries = 2) {
    let retries = 0;
    while (retries <= max_retries) {
        try {
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: request.headers,
                body: request.body,
            });
            if (response.ok || response.status === 304) {
                return response;
            } else if (response.status === 404) {
                return new Response('Error: Image Not Found', { status: 404 });
            } else {
                retries++;
            }
        } catch (error) {
            retries++;
        }
    }
    return null;
}

export function isTgChannel(imgRecord) {
    return imgRecord.metadata?.Channel === 'Telegram' || imgRecord.metadata?.Channel === 'TelegramNew';
}

// 图片可访问性检查
export async function returnWithCheck(context, imgRecord) {
    const isPreviewMode = context.fileAccess?.isPreviewMode === true;
    const isAuthorized = context.fileAccess?.authResult?.authorized === true;
    const { securityConfig } = context;
    const response = new Response('success', { status: 200 });

    // 预览模式需要认证
    if (isPreviewMode && !isAuthorized) {
        return unauthorizedPreviewResponse();
    }

    const record = imgRecord;
    if (record.metadata === null) {
        context.fileAccess.cacheControl = isPreviewMode ? FILE_CACHE_CONTROL.PRIVATE : FILE_CACHE_CONTROL.PUBLIC;
        return response;
    }

    // 预览模式：已认证，绕过所有限制
    if (isPreviewMode) {
        context.fileAccess.cacheControl = FILE_CACHE_CONTROL.PRIVATE;
        return response;
    }

    // 非预览模式：检查黑白名单
    context.fileAccess.cacheControl = FILE_CACHE_CONTROL.PUBLIC;

    // 1. 检查黑名单标签（最高优先级）
    if (record.metadata.Tags?.includes('blocked')) {
        return await returnBlockedResponse(context.url, 'file-blocked');
    }

    // 2. 检查白名单模式
    if (securityConfig?.access?.whiteListMode?.enabled) {
        // 白名单模式下，只有带 whitelist 标签的文件可访问
        if (record.metadata.Tags?.includes('whitelist')) {
            return response;  // 有白名单标签，允许访问
        }

        // 没有白名单标签，拒绝访问
        return await returnBlockedResponse(context.url, 'whitelist-blocked');
    }

    return response;
}

function unauthorizedPreviewResponse() {
    return new Response('Authentication required for preview mode', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': FILE_CACHE_CONTROL.NO_STORE,
        },
    });
}

export async function return404(url) {
    const Img404 = await fetch(url.origin + "/static/media/404.png");
    if (!Img404.ok) {
        return new Response('Error: Image Not Found',
            {
                status: 404,
                headers: {
                    "Cache-Control": "public, max-age=86400"
                }
            }
        );
    } else {
        return new Response(Img404.body, {
            status: 404,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
            },
        });
    }
}

export async function returnBlockedResponse(url, reason = 'blocked') {
    // 尝试获取静态拦截图片
    const blockImg = await fetch(url.origin + "/static/media/BlockImg.png");

    if (!blockImg.ok) {
        // 图片不存在，返回 302 重定向到前端页面
        return new Response(null, {
            status: 302,
            headers: {
                "Location": url.origin + "/blocked",
                "Cache-Control": "no-store",
                "X-Block-Reason": reason
            }
        });
    } else {
        // 图片存在，返回 403 + 图片
        return new Response(blockImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=3600",
                "X-Block-Reason": reason
            },
        });
    }
}

export async function returnBlockImg(url) {
    const blockImg = await fetch(url.origin + "/static/media/BlockImg.png");
    if (!blockImg.ok) {
        return new Response(null, {
            status: 302,
            headers: {
                "Location": url.origin + "/blockimg",
                "Cache-Control": "public, max-age=86400"
            }
        })
    } else {
        return new Response(blockImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
            },
        });
    }
}

export async function returnWhiteListImg(url) {
    const WhiteListImg = await fetch(url.origin + "/static/media/WhiteListOn.png");
    if (!WhiteListImg.ok) {
        return new Response(null, {
            status: 302,
            headers: {
                "Location": url.origin + "/whiteliston",
                "Cache-Control": "public, max-age=86400"
            }
        })
    } else {
        return new Response(WhiteListImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
            },
        });
    }
}
