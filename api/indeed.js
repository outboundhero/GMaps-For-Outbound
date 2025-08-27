import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import { stringify } from 'querystring';
import { kv } from '@vercel/kv';

async function totalNumberOfPages(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract total number of jobs - try multiple selectors
    let totalNumberOfJobs = "0";
    
    // Try different selectors for job count
    const selectors = [
        '.jobsearch-JobCountAndSortPane-jobCount',
        '[class*="JobCountAndSortPane-jobCount"]',
        'div[class*="jobCount"]',
        // Look in the page content for pattern like "19 jobs"
        'h1', 'title'
    ];
    
    for (const selector of selectors) {
        const elements = doc.querySelectorAll(selector);
        for (const element of elements) {
            const text = element.textContent;
            const matches = text.match(/(\d+)\s*(?:jobs?|results?)/i);
            if (matches) {
                totalNumberOfJobs = matches[1];
                console.log(`Found job count using selector ${selector}: ${totalNumberOfJobs}`);
                break;
            }
        }
        if (totalNumberOfJobs !== "0") break;
    }
    
    // If still not found, look in the HTML directly
    if (totalNumberOfJobs === "0") {
        const htmlMatch = html.match(/(\d+)\s*(?:jobs?\s*available|results?)/i);
        if (htmlMatch) {
            totalNumberOfJobs = htmlMatch[1];
            console.log(`Found job count in HTML text: ${totalNumberOfJobs}`);
        }
    }

    // Return the total number of jobs divided by 15
    return Math.ceil(parseInt(totalNumberOfJobs) / 15);
}

async function extractJobInfo(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const results = [];

    console.log("we are extracting the job info");
    console.log(html.substring(0, 2000));

    // Extract total number of jobs
    let totalNumberOfJobs = "0";
    
    // Try to find job count in multiple ways
    const jobCountSelectors = [
        '.jobsearch-JobCountAndSortPane-jobCount',
        '[class*="JobCountAndSortPane-jobCount"]',
        'div[class*="jobCount"]'
    ];
    
    for (const selector of jobCountSelectors) {
        const element = doc.querySelector(selector);
        if (element) {
            const text = element.textContent;
            const matches = text.match(/(\d+)/);
            if (matches) {
                totalNumberOfJobs = matches[0];
                break;
            }
        }
    }
    
    // Fallback: look for job count in page title or HTML
    if (totalNumberOfJobs === "0") {
        const titleElement = doc.querySelector('title');
        if (titleElement) {
            const matches = titleElement.textContent.match(/(\d+)\s*(?:jobs?|results?)/i);
            if (matches) {
                totalNumberOfJobs = matches[1];
            }
        }
    }
    
    console.log("Total number of jobs found:", totalNumberOfJobs);
    
    // First, try to extract all data from script tags
    const scripts = doc.querySelectorAll('script');
    console.log("Found", scripts.length, "script tags");
    
    let scriptJobData = [];
    let companyDataMap = new Map(); // Map job titles to company info
    
    scripts.forEach((script, index) => {
        const content = script.textContent;
        if (content.length > 1000) {
            console.log(`Script ${index} content length:`, content.length);
            
            // Look for structured job data in scripts
            if (content.includes('"jobkey"') || content.includes('"title"') || 
                content.includes('"company"') || content.includes('"companyName"') ||
                content.includes('"jobtitle"')) {
                console.log(`Found potential job data in script ${index}`);
                
                try {
                    // Extract job data using regex patterns
                    // Pattern 1: Look for title and company pairs
                    const titlePattern = /"title"\s*:\s*"([^"]+)"/g;
                    const jobTitlePattern = /"jobtitle"\s*:\s*"([^"]+)"/g;
                    const companyPattern = /"company"\s*:\s*"([^"]+)"/g;
                    const companyNamePattern = /"companyName"\s*:\s*"([^"]+)"/g;
                    const overviewPattern = /"companyOverviewLink"\s*:\s*"([^"]+)"/g;
                    
                    let titles = [];
                    let companies = [];
                    let overviewLinks = [];
                    
                    // Extract titles (try both patterns)
                    let match;
                    while ((match = titlePattern.exec(content)) !== null) {
                        titles.push(match[1]);
                    }
                    
                    // If no titles found, try jobtitle pattern
                    if (titles.length === 0) {
                        while ((match = jobTitlePattern.exec(content)) !== null) {
                            titles.push(match[1]);
                        }
                    }
                    
                    // Extract companies (try both patterns)
                    while ((match = companyPattern.exec(content)) !== null) {
                        companies.push(match[1]);
                    }
                    
                    if (companies.length === 0) {
                        while ((match = companyNamePattern.exec(content)) !== null) {
                            companies.push(match[1]);
                        }
                    }
                    
                    // Extract overview links
                    while ((match = overviewPattern.exec(content)) !== null) {
                        const link = match[1];
                        if (link.startsWith('/cmp/')) {
                            overviewLinks.push(`https://www.indeed.com${link}`);
                        } else if (link.includes('\\u002F')) {
                            // Handle unicode escaped URLs
                            const cleanLink = link
                                .replace(/\\u002F/g, '/')
                                .replace(/\\\//g, '/')
                                .replace(/\\/g, '');
                            overviewLinks.push(cleanLink.startsWith('http') ? cleanLink : `https://www.indeed.com${cleanLink}`);
                        } else {
                            overviewLinks.push(link);
                        }
                    }
                    
                    // Also try to find job data in a more structured way
                    // Look for patterns like {title:"...",company:"..."}
                    const structuredPattern = /\{[^}]*"(?:title|jobtitle)"\s*:\s*"([^"]+)"[^}]*"(?:company|companyName)"\s*:\s*"([^"]+)"[^}]*\}/g;
                    while ((match = structuredPattern.exec(content)) !== null) {
                        const title = match[1].replace(/\\u[0-9a-fA-F]{4}/g, '');
                        const company = match[2].replace(/\\u[0-9a-fA-F]{4}/g, '');
                        
                        // Add to map for matching
                        companyDataMap.set(title, {
                            company: company,
                            link: null
                        });
                        
                        // Also add to arrays if not already there
                        if (!titles.includes(title)) titles.push(title);
                        if (!companies.includes(company)) companies.push(company);
                    }
                    
                    // Create job objects from extracted data
                    const numJobs = Math.min(titles.length, companies.length);
                    for (let i = 0; i < numJobs; i++) {
                        const jobTitle = titles[i].replace(/\\u[0-9a-fA-F]{4}/g, ''); // Remove unicode escapes
                        const companyName = companies[i].replace(/\\u[0-9a-fA-F]{4}/g, '');
                        const overviewLink = overviewLinks[i] || null;
                        
                        scriptJobData.push({
                            job_title: jobTitle,
                            job_company: companyName,
                            companyOverviewLink: overviewLink
                        });
                        
                        // Store in map for later matching
                        companyDataMap.set(jobTitle, {
                            company: companyName,
                            link: overviewLink
                        });
                    }
                    
                    console.log(`Extracted from script ${index}:`, {
                        titlesFound: titles.length,
                        companiesFound: companies.length,
                        overviewLinksFound: overviewLinks.length,
                        mapSize: companyDataMap.size
                    });
                    
                    if (titles.length > 0) {
                        console.log('Sample titles:', titles.slice(0, 3));
                    }
                    if (companies.length > 0) {
                        console.log('Sample companies:', companies.slice(0, 3));
                    }
                    
                    // Alternative: Try to parse window._initialData
                    const dataMatch = content.match(/window\._initialData\s*=\s*({[\s\S]*?});/);
                    if (dataMatch) {
                        try {
                            // Clean the JSON string before parsing
                            const cleanedJson = dataMatch[1]
                                .replace(/\n/g, ' ')
                                .replace(/\r/g, ' ')
                                .replace(/\t/g, ' ');
                            
                            const data = JSON.parse(cleanedJson);
                            
                            // Navigate through various possible data structures
                            if (data.resultsListData && data.resultsListData.results) {
                                data.resultsListData.results.forEach(job => {
                                    const title = job.title || job.jobtitle || job.jobTitle;
                                    const company = job.company || job.companyName;
                                    const link = job.companyOverviewLink;
                                    
                                    if (title && company) {
                                        companyDataMap.set(title, {
                                            company: company,
                                            link: link ? `https://www.indeed.com${link}` : null
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            console.log('Could not parse _initialData:', e.message);
                        }
                    }
                } catch (e) {
                    console.log('Error extracting from script:', e.message);
                }
            }
        }
    });
    
    // Now extract job cards from DOM
    const jobCardSelectors = [
        '.jobsearch-SerpJobCard',
        '.job_seen_beacon',
        '[class*="job_seen_beacon"]',
        '.jobsearch-ResultsList > li',
        '[data-jk]',
        'div[class*="slider_container"] .slider_item',
        'td#resultsCol .result',
        '.jobsearch-ResultsList [class*="result"]',
        'div[class*="jobsearch-ResultsList"] > div'
    ];
    
    let jobCards = [];
    for (const selector of jobCardSelectors) {
        jobCards = doc.querySelectorAll(selector);
        if (jobCards.length > 0) {
            console.log(`Found ${jobCards.length} job cards with selector: ${selector}`);
            break;
        }
    }
    
    // If no job cards found, try to find job title headers
    if (jobCards.length === 0) {
        const titleHeaders = doc.querySelectorAll('h2.jobTitle, h2[class*="jobTitle"]');
        console.log(`Found ${titleHeaders.length} elements with selector: h2.jobTitle`);
        
        titleHeaders.forEach((titleHeader) => {
            const job = {
                job_title: null,
                job_company: null,
                companyOverviewLink: null
            };
            
            // Get job title
            const titleSpan = titleHeader.querySelector('span[title]') || 
                            titleHeader.querySelector('a span') ||
                            titleHeader.querySelector('span');
            
            if (titleSpan) {
                job.job_title = titleSpan.getAttribute('title') || titleSpan.textContent.trim();
            } else if (titleHeader.textContent) {
                job.job_title = titleHeader.textContent.trim();
            }
            
            // Try to find the parent job card container
            let jobCard = titleHeader.closest('[class*="job_seen_beacon"]') ||
                         titleHeader.closest('.jobsearch-SerpJobCard') ||
                         titleHeader.closest('[data-jk]') ||
                         titleHeader.closest('td.resultContent') ||
                         titleHeader.parentElement?.parentElement?.parentElement ||
                         titleHeader.parentElement?.parentElement;
            
            if (jobCard) {
                // Look for company name within the job card - search broader area
                const companySelectors = [
                    '[data-testid="company-name"]',
                    'span[data-testid="company-name"]',
                    'div[data-testid="company-name"]',
                    'a[data-testid="company-name"]',
                    '.companyName',
                    '[class*="companyName"]',
                    'div[class*="company"]',
                    'span[class*="company"]',
                    'a[class*="company"]',
                    'div.company',
                    'span.company'
                ];
                
                for (const selector of companySelectors) {
                    const companyEl = jobCard.querySelector(selector);
                    if (companyEl && companyEl.textContent) {
                        // Clean up the company name
                        let companyText = companyEl.textContent.trim();
                        // Remove any "new" badges or extra text
                        companyText = companyText.replace(/\bnew\b/gi, '').trim();
                        if (companyText && companyText.length > 0) {
                            job.job_company = companyText;
                            break;
                        }
                    }
                }
                
                // If still no company, look in the next sibling or broader area
                if (!job.job_company) {
                    const nextElement = titleHeader.nextElementSibling;
                    if (nextElement) {
                        for (const selector of companySelectors) {
                            const companyEl = nextElement.querySelector(selector) || 
                                            (nextElement.matches(selector) ? nextElement : null);
                            if (companyEl && companyEl.textContent) {
                                let companyText = companyEl.textContent.trim();
                                companyText = companyText.replace(/\bnew\b/gi, '').trim();
                                if (companyText && companyText.length > 0) {
                                    job.job_company = companyText;
                                    break;
                                }
                            }
                        }
                    }
                }
                
                // Look for company overview link
                const linkEl = jobCard.querySelector('a[href*="/cmp/"]');
                if (linkEl) {
                    const href = linkEl.getAttribute('href');
                    job.companyOverviewLink = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
                }
            }
            
            // If we still don't have company info, try to get it from the script data
            if (job.job_title && (!job.job_company || !job.companyOverviewLink)) {
                const scriptData = companyDataMap.get(job.job_title);
                if (scriptData) {
                    if (!job.job_company && scriptData.company) {
                        job.job_company = scriptData.company;
                    }
                    if (!job.companyOverviewLink && scriptData.link) {
                        job.companyOverviewLink = scriptData.link;
                    }
                }
            }
            
            // Only add if we have at least a job title
            if (job.job_title) {
                results.push(job);
            }
        });
    } else {
        // Process job cards if found
        jobCards.forEach((card, cardIndex) => {
            const job = {
                job_title: null,
                job_company: null,
                companyOverviewLink: null
            };
            
            // Extract job title
            const titleSelectors = [
                'h2.jobTitle span[title]',
                'h2[class*="jobTitle"] span[title]',
                'a[data-testid="job-title"]',
                '.jobTitle',
                'h2 a span',
                'h2 span'
            ];
            
            for (const selector of titleSelectors) {
                const titleEl = card.querySelector(selector);
                if (titleEl) {
                    job.job_title = titleEl.getAttribute('title') || titleEl.textContent.trim();
                    if (job.job_title) break;
                }
            }
            
            // Extract company name - look for the ACTUAL company element, not just any text
            const companySelectors = [
                '[data-testid="company-name"]',
                'div[data-testid="company-name"]',
                'span[data-testid="company-name"]',
                'a[data-testid="company-name"]',
                '.companyName',
                '[class*="companyName"]',
                'div.companyName',
                'span.companyName'
            ];
            
            for (const selector of companySelectors) {
                const companyEl = card.querySelector(selector);
                if (companyEl) {
                    let companyText = companyEl.textContent.trim();
                    // Clean up company name
                    companyText = companyText.replace(/\bnew\b/gi, '').trim();
                    if (companyText && companyText.length > 0) {
                        job.job_company = companyText;
                        break;
                    }
                }
            }
            
            // Extract company overview link - ONLY from the same card
            // Look for company link that's actually related to the company name
            const linkSelectors = [
                'a[href*="/cmp/"][data-testid="company-name"]',
                'div[data-testid="company-name"] a[href*="/cmp/"]',
                'span[data-testid="company-name"] a[href*="/cmp/"]',
                '.companyName a[href*="/cmp/"]',
                'a.companyName[href*="/cmp/"]'
            ];
            
            for (const selector of linkSelectors) {
                const linkEl = card.querySelector(selector);
                if (linkEl) {
                    const href = linkEl.getAttribute('href');
                    job.companyOverviewLink = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
                    break;
                }
            }
            
            // If no link found with specific selectors, try general link but verify it matches company
            if (!job.companyOverviewLink && job.job_company) {
                const allLinks = card.querySelectorAll('a[href*="/cmp/"]');
                for (const link of allLinks) {
                    const href = link.getAttribute('href');
                    // Check if the link text matches the company name
                    if (link.textContent && link.textContent.includes(job.job_company)) {
                        job.companyOverviewLink = href.startsWith('http') ? href : `https://www.indeed.com${href}`;
                        break;
                    }
                }
            }
            
            // Only use script data as fallback if we have matching title
            if (job.job_title && (!job.job_company || !job.companyOverviewLink)) {
                const scriptData = companyDataMap.get(job.job_title);
                if (scriptData) {
                    if (!job.job_company) job.job_company = scriptData.company;
                    if (!job.companyOverviewLink) job.companyOverviewLink = scriptData.link;
                }
            }
            
            // Log for debugging
            if (cardIndex < 3) {
                console.log(`Job ${cardIndex + 1} extracted:`, {
                    title: job.job_title,
                    company: job.job_company,
                    link: job.companyOverviewLink
                });
            }
            
            if (job.job_title) {
                results.push(job);
            }
        });
    }
    
    // If DOM extraction didn't work well, use script data
    if (results.length === 0 && scriptJobData.length > 0) {
        console.log("Using script-extracted data as fallback");
        results.push(...scriptJobData);
    }
    
    console.log("Total job data found:", results.length);
    console.log("Final results:", JSON.stringify(results.slice(0, 3), null, 2)); // Log first 3 for brevity
    
    return {
        jobs: results,
        total_number_of_jobs: totalNumberOfJobs
    };
}

export function generateIndeedUrls(keyword, location, page_number, premium = false) {
    const baseUrl = "https://www.indeed.com/jobs";
    console.log("we are starting the indeed search using the variables", keyword, location);

    // Create query parameters
    const params = {
        q: keyword,
        l: location,
        radius: "0"
    };
    
    // Only add start parameter for pages beyond the first
    if (page_number > 0) {
        params.start = page_number * 10;
    }

    // Generate the original Indeed search URL
    const originalUrl = `${baseUrl}?${stringify(params)}`;
    console.log(originalUrl);

    const scraperApiKey = "de3bfafaa930e82099f66a7ab7bb18fe";

    // Generate the ScraperAPI URL with optional premium parameter
    let scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(originalUrl)}`;
    
    // Add premium or ultra_premium based on retry logic
    if (premium === 'ultra') {
        scraperUrl += '&ultra_premium=true';
    } else if (premium) {
        scraperUrl += '&premium=true';
    }
    
    console.log(scraperUrl);

    return {
        originalUrl: originalUrl,
        scraperUrl: scraperUrl
    };
}

function getValidTokens() {
    const tokenKeys = Object.keys(process.env).filter(key => key.startsWith('AUTH_TOKEN_'));
    return tokenKeys.map(key => process.env[key]);
}

// Token counter system
const tokenCounters = new Map();

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
    const isValid = validTokens.includes(token);
    console.log('Is token valid?', isValid);
    return isValid;
}

async function scrapeCompanyOverview(companyUrl) {
    try {
        const scraperApiKey = "de3bfafaa930e82099f66a7ab7bb18fe";
        let scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(companyUrl)}`;
        console.log('ScraperAPI URL for company overview:', scraperUrl);
        
        let response = await fetch(scraperUrl);
        console.log('ScraperAPI response status for company overview:', response.status);
        
        // Retry with premium if failed
        if (response.status === 500) {
            scraperUrl += '&premium=true';
            response = await fetch(scraperUrl);
            console.log('Retry with premium, status:', response.status);
        }
        
        const html = await response.text();
        console.log('Raw HTML from company overview (first 1000 chars):', html.substring(0, 1000));
        
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        
        let industry = null;
        let websiteUrl = null;
        
        // Method 1: Look in scripts
        const scripts = doc.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent;
            if (content.includes('"industry"')) {
                const industryMatch = content.match(/"industry":"([^"]+)"/);
                if (industryMatch) {
                    industry = industryMatch[1];
                    console.log('Found industry:', industry);
                }
            }
            if (content.includes('"websiteUrl"')) {
                const websiteMatch = content.match(/"websiteUrl"[:\s]*{[^}]*"url":"([^"]+)"/);
                if (websiteMatch) {
                    websiteUrl = websiteMatch[1];
                    console.log('Found website URL:', websiteUrl);
                }
            }
        }
        
        // Method 2: Look in DOM elements
        if (!industry) {
            const industryEl = doc.querySelector('[data-testid="industry"]') || 
                              doc.querySelector('[class*="industry"]');
            if (industryEl) {
                industry = industryEl.textContent.trim();
            }
        }
        
        if (!websiteUrl) {
            const websiteEl = doc.querySelector('a[href*="http"][rel*="noopener"]');
            if (websiteEl) {
                websiteUrl = websiteEl.getAttribute('href');
            }
        }
        
        return {
            industry,
            websiteUrl
        };
    } catch (error) {
        console.error('Error scraping company overview:', error);
        return {
            industry: null,
            websiteUrl: null
        };
    }
}

async function saveToKV(authToken, finalJobs, totalNumberOfJobs, keyword, location, extra) {
    try {
        const tokenIndex = getValidTokens().indexOf(authToken);
        const timestamp = new Date().toISOString();
        
        await kv.set(`indeed:count:${tokenIndex + 1}:${timestamp}`, {
            count: finalJobs.length,
            total_number_of_jobs: totalNumberOfJobs,
            pages_scraped: getTokenCounter(authToken),
            keyword,
            location,
            timestamp
        });

        await kv.set(`indeed:jobs:${tokenIndex + 1}:${timestamp}`, {
            jobs: finalJobs,
            extra: extra || null
        });

        await kv.incr(`indeed:total_count:token${tokenIndex + 1}`);
    } catch (error) {
        console.error('Error saving to KV store:', error);
    }
}

async function processJobSearch(req, authToken) {
    const { keyword, location, company_details, extra } = req.body;
    console.log('Search parameters:', { keyword, location, company_details, extra });
    
    if (!keyword || !location) {
        throw new Error('Keyword and location are required in the request body');
    }
    
    // Initial attempt without premium
    let { scraperUrl } = generateIndeedUrls(keyword, location, 0);
    console.log('Initial ScraperAPI URL:', scraperUrl);

    let response = await fetch(scraperUrl);
    console.log('Initial ScraperAPI response status:', response.status);
    
    // Implement retry logic with premium and ultra_premium
    let retryCount = 0;
    let html = '';
    
    while (response.status === 500 && retryCount < 2) {
        retryCount++;
        const premiumLevel = retryCount === 1 ? true : 'ultra';
        console.log(`Retry ${retryCount} with premium level:`, premiumLevel);
        
        const { scraperUrl: retryUrl } = generateIndeedUrls(keyword, location, 0, premiumLevel);
        response = await fetch(retryUrl);
        console.log(`Retry ${retryCount} response status:`, response.status);
    }
    
    html = await response.text();
    console.log('Raw HTML from first page (first 1000 chars):', html.substring(0, 1000));
    
    // Check if we got an error message instead of HTML
    if (html.includes('Request failed') || html.includes('Protected domains')) {
        console.error('ScraperAPI error:', html);
        throw new Error('Indeed may require additional authentication or is blocking scraping attempts');
    }
    
    // Extract job information from the scraped HTML
    const firstPageJobs = await extractJobInfo(html);
    console.log('First page jobs extracted:', JSON.stringify(firstPageJobs, null, 2));
    
    // Only continue to other pages if we found jobs on the first page
    const allJobs = [...firstPageJobs.jobs];
    incrementTokenCounter(authToken);
    
    if (allJobs.length > 0) {
        const totalPages = await totalNumberOfPages(html);
        console.log('Total pages found:', totalPages);
        
        // Limit pages to avoid excessive scraping and timeout
        const maxPages = Math.min(totalPages, 2); // Reduced to 2 pages to prevent timeout
        
        for (let i = 1; i < maxPages; i++) {
            console.log(`\nProcessing page ${i + 1} of ${maxPages}`);
            const { scraperUrl } = generateIndeedUrls(keyword, location, i);
            console.log(`ScraperAPI URL for page ${i + 1}:`, scraperUrl);
            
            const response = await fetch(scraperUrl);
            console.log(`ScraperAPI response status for page ${i + 1}:`, response.status);
            
            if (response.status === 200) {
                const html = await response.text();
                const pageJobs = await extractJobInfo(html);
                console.log(`Jobs extracted from page ${i + 1}:`, pageJobs.jobs.length);
                
                allJobs.push(...pageJobs.jobs);
                incrementTokenCounter(authToken);
            } else {
                console.log(`Skipping page ${i + 1} due to error`);
                break; // Stop pagination on error
            }
        }
    }

    let finalJobs = allJobs;

    // Only process company details if requested and we have jobs
    if (company_details && company_details !== 'False' && allJobs.length > 0) {
        console.log('\nStarting company overview scraping...');
        
        // Limit company detail fetching to first 5 jobs to avoid timeout
        const jobsToProcess = allJobs.slice(0, 5);
        
        // Process company details in parallel with timeout for each
        const companyDetailsPromises = jobsToProcess.map(async (job, index) => {
            console.log(`\nProcessing company overview for job ${index + 1} of ${jobsToProcess.length}`);
            let cleanedJob = { ...job };
            
            if (job.companyOverviewLink) {
                try {
                    // Set individual timeout for company detail fetch (5 seconds)
                    const companyTimeout = new Promise((resolve) => 
                        setTimeout(() => resolve({ industry: null, websiteUrl: null }), 5000)
                    );
                    
                    const withoutQuery = job.companyOverviewLink.split('?')[0];
                    const cleanedUrl = withoutQuery
                        .replace(/\\u002F/g, '/')
                        .replace(/\\\//g, '/')
                        .replace(/\\/g, '');
                    
                    cleanedJob.companyOverviewLink = cleanedUrl;
                    console.log(`Company overview URL for job ${index + 1}:`, cleanedUrl);
                    
                    const { industry, websiteUrl } = await Promise.race([
                        scrapeCompanyOverview(cleanedUrl),
                        companyTimeout
                    ]);
                    
                    if (industry) cleanedJob.industry = industry;
                    if (websiteUrl) cleanedJob.websiteUrl = websiteUrl;
                } catch (err) {
                    console.log(`Failed to get company details for job ${index + 1}:`, err.message);
                }
            }
            
            return cleanedJob;
        });
        
        finalJobs = await Promise.all(companyDetailsPromises);
        
        // Add remaining jobs without company details
        if (allJobs.length > 5) {
            finalJobs.push(...allJobs.slice(5));
        }
    } else if (!company_details || company_details === 'False') {
        // If company_details is false, only keep basic info
        finalJobs = allJobs.map(job => ({
            job_title: job.job_title,
            job_company: job.job_company
        }));
    }

    console.log('\nFinal processed jobs:', finalJobs.length);

    const responseData = {
        count: finalJobs.length,
        total_number_of_jobs: firstPageJobs.total_number_of_jobs,
        jobs: finalJobs,
        pages_scraped: getTokenCounter(authToken)
    };

    if (extra) {
        responseData.extra = extra;
    }

    // Save to KV store (but don't wait for it)
    saveToKV(authToken, finalJobs, firstPageJobs.total_number_of_jobs, keyword, location, extra).catch(err => 
        console.error('Error saving to KV store:', err)
    );

    return responseData;
}

export default async function handler(req, res) {
    // Set a timeout for the entire request (55 seconds to allow time for response)
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout - processing took too long')), 55000)
    );
    
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const authToken = req.headers.authentication;

    if (!authToken || !isValidToken(authToken)) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid or missing token" });
    }

    try {
        // Wrap the main logic in Promise.race with timeout
        const result = await Promise.race([
            processJobSearch(req, authToken),
            timeoutPromise
        ]);
        
        res.json(result);

    } catch (error) {
        console.error('Error in handler:', error);
        
        if (error.message === 'Request timeout - processing took too long') {
            res.status(504).json({ 
                error: 'Request timeout',
                message: 'The request took too long to process. Try reducing the scope or disabling company_details.',
                partial_results: []
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to scrape job information',
                message: error.message 
            });
        }
    }
}
