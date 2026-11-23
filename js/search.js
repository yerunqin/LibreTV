/**
 * 归一化标题/关键词：全角转半角、转小写、去除空白与标点符号。
 * 用于跨全角/半角标点差异匹配（源站存「嫁金钗」而用户搜「嫁金钗」等）。
 */
function normalizeSearchTitle(s) {
    return (s || '').toString()
        .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 关键词是否完整命中标题（带数字边界校验，避免搜「第2季」命中「12/20」）。
 */
function searchKeywordInTitle(title, keyword) {
    if (!title || !keyword) return false;
    let idx = title.indexOf(keyword);
    while (idx >= 0) {
        const before = title[idx - 1] || '';
        const after = title[idx + keyword.length] || '';
        const digitBoundOk = (!/\d/u.test(keyword) || !/\d/u.test(before)) &&
            (!/\d$/u.test(keyword) || !/\d/u.test(after));
        if (digitBoundOk) return true;
        idx = title.indexOf(keyword, idx + 1);
    }
    return false;
}

/**
 * 判断单条结果是否真的命中搜索词。
 * - 归一化后标题包含完整关键词
 * - 多词查询（空格分隔）要求每个词都命中
 * - 末尾裸数字可与标题「第 N 季」互认（如搜「庆余年 2」命中「庆余年第二季」）
 */
function isSearchResultRelevant(vodName, query) {
    const title = normalizeSearchTitle(vodName);
    const normalizedQuery = normalizeSearchTitle(query);
    if (!normalizedQuery) return true;
    if (!title) return false;
    if (searchKeywordInTitle(title, normalizedQuery)) return true;

    // 多词查询：每个词都命中即可
    const tokens = (query || '').trim().split(/\s+/).map(normalizeSearchTitle).filter(Boolean);
    if (tokens.length > 1 && tokens.every(t => searchKeywordInTitle(title, t))) return true;

    // 查询末尾数字 ↔ 标题「第 N 季」/末尾数字 互认
    const cnDigits = '零一二三四五六七八九';
    const toSeason = (v) => {
        let n = Number(v);
        if (Number.isFinite(n)) return n;
        const s = v.replace('两', '二');
        if (s.length === 1 && cnDigits.includes(s)) return cnDigits.indexOf(s);
        const m = s.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u);
        if (m) return (m[1] ? cnDigits.indexOf(m[1]) : 1) * 10 + (m[2] ? cnDigits.indexOf(m[2]) : 0);
        return NaN;
    };
    const qSeason = (query || '').trim().match(/^(.*?)\s*第?\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季?$/u);
    if (qSeason && Number.isFinite(toSeason(qSeason[2])) && normalizeSearchTitle(qSeason[1])) {
        const tSeason = (vodName || '').match(/^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$/u)
            || (vodName || '').match(/^(.*?)\s+([1-9]\d?)$/u);
        if (tSeason && toSeason(qSeason[2]) === toSeason(tSeason[2])) {
            return searchKeywordInTitle(normalizeSearchTitle(tSeason[1]), normalizeSearchTitle(qSeason[1]));
        }
    }
    return false;
}

/**
 * 相关性过滤：丢弃与关键词无关的条目。
 * 关键：命中数为 0 时返回空数组（不再回退原列表），
 * 否则采集站「查不到就返回默认全量目录」的行为会把无关结果淹没搜索页。
 */
function filterRelevantSearchResults(list, query) {
    if (!Array.isArray(list)) return [];
    return list.filter(item => isSearchResultRelevant(item.vod_name || '', query));
}

async function searchByAPIAndKeyWord(apiId, query) {
    try {
        let apiUrl, apiName, apiBaseUrl;

        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];

            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
        }

        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(PROXY_URL + encodeURIComponent(apiUrl), {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return [];
        }

        const data = await response.json();

        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }

        // 相关性过滤：先过滤第一页，若一条都不命中，判定为源站默认目录兜底，直接丢弃该源
        const relevantFirstPage = filterRelevantSearchResults(data.list, query);
        if (relevantFirstPage.length === 0) {
            return [];
        }

        // 处理第一页结果
        const results = relevantFirstPage.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
        }));

        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);

        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];

            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);

                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageController = new AbortController();
                        const pageTimeoutId = setTimeout(() => pageController.abort(), 8000);

                        const pageResponse = await fetch(PROXY_URL + encodeURIComponent(pageUrl), {
                            headers: API_CONFIG.search.headers,
                            signal: pageController.signal
                        });

                        clearTimeout(pageTimeoutId);

                        if (!pageResponse.ok) return [];

                        const pageData = await pageResponse.json();

                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];

                        // 处理当前页结果（同样做相关性过滤）
                        const relevantPageItems = filterRelevantSearchResults(pageData.list, query);
                        return relevantPageItems.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId,
                            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                        }));
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();

                additionalPagePromises.push(pagePromise);
            }

            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);

            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }

        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}
