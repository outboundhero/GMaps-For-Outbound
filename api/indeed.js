import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import { stringify } from 'querystring';
import { kv } from '@vercel/kv';

// Cache for compiled regex patterns
const REGEX_CACHE = {
    jobCount: /(\d+)\s*(?:jobs?|results?)/i,
    title: /"title"\s*:\s*"([^"]+)"/g,
    company: /"company"\s*:\s*"([^"]+)"/g,
    companyName: /"companyName"\s*:\s*"([^"]+)"/g,
    overviewLink: /"companyOverviewLink"\s*:\s*"([^"]+)"/g,
    industry: /"industry":"([^"]+)"/,
    websiteUrl: /"websiteUrl"[:\s]*{[^}]*"url":"([^"]+)"/
};

// Token management
const tokenCounters = new Map();

function getValidTokens() {
    const tokenKeys = Object.keys(process.env).filter(key => key.startsWith('AUTH_TOKEN_'));
    return tokenKeys.map(key => process.env[key]);
}

function incrementTokenCounter(token) {
    const tokenKey = Object.keys(process.env).find(key => process.env[key] === token);
    if (!tokenKey) return;
    
    const counterKey = `${tokenKey}_counter`;
    const currentCount = tokenCounters.get(counterKey) || 0;
    tokenCounters.set(counterKey, currentCount + 1);
    return currentCount + 1;
}

function getTokenCounter(token) {
    const tokenKey = Object.keys(process.env).find(key => process.env[key] === token);
    if (!tokenKey) return 0;
    
    const counterKey = `${tokenKey}_counter`;
    return tokenCounters.get(counterKey) || 0;
}

function isValidToken(token) {
    const validTokens = getValidTokens();
    if (validTokens.length === 0) {
        console.error('No valid tokens found in environment variables');
        return false;
    }
    return validTokens.includes(token);
}

// Optimized script data extraction
function extractScriptData(doc) {
    const scripts = doc.querySelectorAll('script');
    const companyMap = new Map();
    let totalJobs = "0";
    
    // Single pass through scripts
    for (const script of scripts) {
        const content = script.textContent;
        if (content.length < 1000) continue;
        
        // Check if script contains job data
        if (!content.includes('"jobkey"') && !content.includes('"title"') && 
            !content.includes('"company"') && !content.includes('"companyName"')) {
            continue;
        }
        
        // Extract all data in one pass
        const titles = [];
        const companies = [];
        const overviewLinks = [];
        
        let match;
        
        // Reset regex lastIndex for global patterns
        REGEX_CACHE.title.lastIndex = 0;
        REGEX_CACHE.company.lastIndex = 0;
        REGEX_CACHE.companyName.lastIndex = 0;
        REGEX_CACHE.overviewLink.lastIndex = 0;
        
        while ((match = REGEX_CACHE.title.exec(content)) !== null) {
            titles.push(match[1].replace(/\\u[0-9a-fA-F]{4}/g, ''));
        }
        
        while ((match = REGEX_CACHE.company.exec(content)) !== null) {
            companies.push(match[1].replace(/\\u[0-9a-fA-F]{4}/g, ''));
        }
        
        if (companies.length === 0) {
            while ((match = REGEX_CACHE.companyName.exec(content)) !== null) {
                companies.push(match[1].replace(/\\u[0-9a-fA-F]{4}/g, ''));
            }
        }
        
        while ((match = REGEX_CACHE.overviewLink.exec(content)) !== null) {
            const link = match[1];
            const cleanLink = link
                .replace(/\\u002F/g, '/')
                .replace(/\\\//g, '/')
                .replace(/\\/g, '');
            overviewLinks.push(cleanLink.startsWith('http') ? cleanLink : `https://www.indeed.com${cleanLink}`);
        }
        
        // Build company map
        const numJobs = Math.min(titles.length, companies.length);
        for (let i = 0; i < numJobs; i++) {
            if (titles[i] && companies[i]) {
                companyMap.set(titles[i], {
                    company: companies[i],
                    link: overviewLinks[i] || null
                });
            }
        }
        
        // Look for total job count
        if (totalJobs === "0") {
            const jobCountMatch = content.match(REGEX_CACHE.jobCount);
            if (jobCountMatch) {
                totalJobs = jobCountMatch[1];
            }
        }
    }
    
    return { companyMap, totalJobs };
}

// Optimized job extraction from DOM element
function extractJobFromElement(element, companyDataMap) {
    const job = {
        job_title: null,
        job_company: null,
        companyOverviewLink: null
    };
    
    // Get job title efficiently
    const titleEl = element.querySelector('span[title]') || 
                   element.querySelector('h2 span') ||
                   element.querySelector('[data-testid="job-title"]');
    
    if (titleEl) {
        job.job_title = titleEl.getAttribute('title') || titleEl.textContent.trim();
    }
    
    // Get parent container for company info
    const container = element.closest('[class*="job_seen_beacon"]') || 
                     element.closest('[data-jk]') || 
                     element.parentElement;
    
    if (container) {
        // Get company name
        const companyEl = container.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
        if (companyEl) {
            job.job_company = companyEl.textContent.trim();
        }
        
        // Get company link
        const linkEl = container.querySelector('a[href*="/cmp/"]');
        if (linkEl) {
            const href = linkEl.getAttribute('href');
            job.companyOverviewLink = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
        }
    }
    
    // Use script data as fallback
    if (job.job_title && companyDataMap.has(job.job_title)) {
        const scriptData = companyDataMap.get(job.job_title);
        if (!job.job_company) job.job_company = scriptData.company;
        if (!job.companyOverviewLink) job.companyOverviewLink = scriptData.link;
    }
    
    return job;
}

// Optimized main extraction function
async function extractJobInfo(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const results = [];
    
    // Extract script data once
    const { companyMap, totalJobs } = extractScriptData(doc);
    
    // Use efficient selector combination
    const jobElements = doc.querySelectorAll(
        '.job_seen_beacon, .jobsearch-SerpJobCard, [data-jk], h2.jobTitle, h2[class*="jobTitle"]'
    );
    
    // Process elements
    const processedTitles = new Set();
    
    for (const element of jobElements) {
        const job = extractJobFromElement(element, companyMap);
        
        // Avoid duplicates
        if (job.job_title && !processedTitles.has(job.job_title)) {
            processedTitles.add(job.job_title);
            results.push(job);
        }
    }
    
    // If no DOM results, use script data
    if (results.length === 0 && companyMap.size > 0) {
        for (const [title, data] of companyMap) {
            results.push({
                job_title: title,
                job_company: data.company,
                companyOverviewLink: data.link
            });
        }
    }
    
    return {
        jobs: results,
        total_number_of_jobs: totalJobs
    };
}

// Calculate total pages efficiently
async function totalNumberOfPages(jobData) {
    const total = parseInt(jobData.total_number_of_jobs) || 0;
    return Math.ceil(total / 15);
}

// Generate URLs
export function generateIndeedUrls(keyword, location, page_number, premium = false) {
    const baseUrl = "https://www.indeed.com/jobs";
    const params = {
        q: keyword,
        l: location,
        radius: "0"
    };
    
    if (page_number > 0) {
        params.start = page_number * 10;
    }

    const originalUrl = `${baseUrl}?${stringify(params)}`;
    const scraperApiKey = "de3bfafaa930e82099f66a7ab7bb18fe";
    
    let scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(originalUrl)}`;
    
    if (premium === 'ultra') {
        scraperUrl += '&ultra_premium=true';
    } else if (premium) {
        scraperUrl += '&premium=true';
    }
    
    return { originalUrl, scraperUrl };
}

// Batch processing utility
async function batchProcess(items, batchSize, processor) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map((item, index) => 
                processor(item, i + index)
                    .catch(error => {
                        console.error(`Batch item ${i + index} failed:`, error);
                        return null;
                    })
            )
        );
        results.push(...batchResults.filter(Boolean));
    }
    return results;
}

// Optimized company overview scraping
async function scrapeCompanyOverview(companyUrl) {
    try {
        const scraperApiKey = "de3bfafaa930e82099f66a7ab7bb18fe";
        const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(companyUrl)}`;
        
        const response = await fetch(scraperUrl);
        
        // Only retry if necessary
        if (response.status !== 200) {
            return { industry: null, websiteUrl: null };
        }
        
        const html = await response.text();
        
        // Quick extraction from HTML without full DOM parsing
        const industryMatch = html.match(REGEX_CACHE.industry);
        const websiteMatch = html.match(REGEX_CACHE.websiteUrl);
        
        return {
            industry: industryMatch ? industryMatch[1] : null,
            websiteUrl: websiteMatch ? websiteMatch[1] : null
        };
    } catch (error) {
        console.error('Error scraping company overview:', error.message);
        return { industry: null, websiteUrl: null };
    }
}

// Smart fetch with retry logic
async function smartFetch(url, retryWithPremium = true) {
    try {
        let response = await fetch(url);
        
        if (response.status === 200) {
            return await response.text();
        }
        
        if (retryWithPremium && response.status === 500) {
            const premiumUrl = url.includes('premium=true') 
                ? url.replace('premium=true', 'ultra_premium=true')
                : url + '&premium=true';
            
            response = await fetch(premiumUrl);
            if (response.status === 200) {
                return await response.text();
            }
        }
        
        throw new Error(`Failed to fetch: ${response.status}`);
    } catch (error) {
        console.error('Fetch error:', error);
        throw error;
    }
}

// Main handler
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const authToken = req.headers.authentication;

    if (!authToken || !isValidToken(authToken)) {
        return res.status(401).json({ 
            success: false, 
            error: "Unauthorized: Invalid or missing token" 
        });
    }

    try {
        const { keyword, location, company_details, extra } = req.body;
        
        if (!keyword || !location) {
            return res.status(400).json({ 
                error: 'Keyword and location are required in the request body' 
            });
        }
        
        // Check cache first
        const cacheKey = `indeed:cache:${keyword}:${location}:${company_details || false}`;
        const cached = await kv.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp < 3600000)) { // 1 hour cache
            console.log('Returning cached results');
            return res.json(cached.data);
        }
        
        console.log('Starting search for:', { keyword, location, company_details });
        
        // Fetch first page to determine if we should continue
        const { scraperUrl: firstPageUrl } = generateIndeedUrls(keyword, location, 0);
        const firstPageHtml = await smartFetch(firstPageUrl);
        
        // Check if we got valid HTML
        if (firstPageHtml.includes('Request failed') || firstPageHtml.includes('Protected domains')) {
            return res.status(500).json({ 
                error: 'Failed to scrape Indeed - the site may be blocking requests',
                message: 'Indeed may require additional authentication or is blocking scraping attempts'
            });
        }
        
        const firstPageJobs = await extractJobInfo(firstPageHtml);
        incrementTokenCounter(authToken);
        
        // Early termination if no jobs found
        if (firstPageJobs.jobs.length === 0) {
            const responseData = {
                count: 0,
                total_number_of_jobs: "0",
                jobs: [],
                message: "No jobs found for this search"
            };
            
            // Cache even empty results
            await kv.set(cacheKey, {
                data: responseData,
                timestamp: Date.now()
            }, { ex: 3600 });
            
            return res.json(responseData);
        }
        
        // Determine how many pages to fetch
        const totalPages = await totalNumberOfPages(firstPageJobs);
        const maxPages = firstPageJobs.jobs.length < 5 ? 1 : Math.min(totalPages, 3);
        
        console.log(`Found ${firstPageJobs.jobs.length} jobs on first page, will fetch ${maxPages} total pages`);
        
        let allJobs = [...firstPageJobs.jobs];
        
        // Parallel fetch remaining pages if needed
        if (maxPages > 1) {
            const pagePromises = [];
            
            for (let i = 1; i < maxPages; i++) {
                const { scraperUrl } = generateIndeedUrls(keyword, location, i);
                
                pagePromises.push(
                    smartFetch(scraperUrl, false) // Don't retry with premium for additional pages
                        .then(html => extractJobInfo(html))
                        .then(pageJobs => {
                            incrementTokenCounter(authToken);
                            return pageJobs.jobs;
                        })
                        .catch(error => {
                            console.error(`Failed to fetch page ${i + 1}:`, error);
                            return [];
                        })
                );
            }
            
            const pageResults = await Promise.all(pagePromises);
            pageResults.forEach(jobs => allJobs.push(...jobs));
        }
        
        // Remove duplicates
        const uniqueJobs = Array.from(
            new Map(allJobs.map(job => [job.job_title + job.job_company, job])).values()
        );
        
        let finalJobs = uniqueJobs;
        
        // Process company details if requested
        if (company_details && uniqueJobs.length > 0) {
            console.log('Fetching company details...');
            
            // Limit and batch process company details
            const jobsToProcess = uniqueJobs.slice(0, 10);
            
            finalJobs = await batchProcess(jobsToProcess, 5, async (job) => {
                const cleanedJob = { ...job };
                
                if (job.companyOverviewLink) {
                    const cleanedUrl = job.companyOverviewLink
                        .split('?')[0]
                        .replace(/\\u002F/g, '/')
                        .replace(/\\\//g, '/')
                        .replace(/\\/g, '');
                    
                    cleanedJob.companyOverviewLink = cleanedUrl;
                    
                    const { industry, websiteUrl } = await scrapeCompanyOverview(cleanedUrl);
                    
                    if (industry) cleanedJob.industry = industry;
                    if (websiteUrl) cleanedJob.websiteUrl = websiteUrl;
                }
                
                return cleanedJob;
            });
            
            // Add remaining jobs without company details
            if (uniqueJobs.length > 10) {
                finalJobs.push(...uniqueJobs.slice(10));
            }
        } else if (!company_details) {
            // Return only basic info if company_details is false
            finalJobs = uniqueJobs.map(job => ({
                job_title: job.job_title,
                job_company: job.job_company
            }));
        }
        
        console.log(`Returning ${finalJobs.length} jobs`);
        
        const responseData = {
            count: finalJobs.length,
            total_number_of_jobs: firstPageJobs.total_number_of_jobs,
            jobs: finalJobs,
            pages_scraped: getTokenCounter(authToken)
        };
        
        if (extra) {
            responseData.extra = extra;
        }
        
        // Save to cache and KV store in parallel
        await Promise.all([
            // Cache results
            kv.set(cacheKey, {
                data: responseData,
                timestamp: Date.now()
            }, { ex: 3600 }),
            
            // Save to KV store for analytics
            (async () => {
                try {
                    const tokenIndex = getValidTokens().indexOf(authToken);
                    const timestamp = new Date().toISOString();
                    
                    const pipeline = kv.pipeline();
                    
                    pipeline.set(`indeed:count:${tokenIndex + 1}:${timestamp}`, {
                        count: finalJobs.length,
                        total_number_of_jobs: firstPageJobs.total_number_of_jobs,
                        pages_scraped: getTokenCounter(authToken),
                        keyword,
                        location,
                        timestamp
                    });
                    
                    pipeline.set(`indeed:jobs:${tokenIndex + 1}:${timestamp}`, {
                        jobs: finalJobs,
                        extra: extra || null
                    });
                    
                    pipeline.incr(`indeed:total_count:token${tokenIndex + 1}`);
                    
                    await pipeline.exec();
                } catch (error) {
                    console.error('Error saving to KV store:', error);
                }
            })()
        ]);
        
        res.json(responseData);

    } catch (error) {
        console.error('Error scraping job info:', error);
        res.status(500).json({ 
            error: 'Failed to scrape job information',
            message: error.message 
        });
    }
}
