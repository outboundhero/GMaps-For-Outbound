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
    
    // Method 1: Try to extract from script tags (current data format)
    const scripts = doc.querySelectorAll('script');
    console.log("Found", scripts.length, "script tags");
    
    let jobDataFromScripts = [];
    
    scripts.forEach((script, index) => {
        const content = script.textContent;
        if (content.length > 1000) {  // Only check larger scripts
            console.log(`Script ${index} content length:`, content.length);
            
            // Look for job data patterns in scripts
            if (content.includes('"jobkey"') || content.includes('"jobtitle"') || 
                content.includes('"company"') || content.includes('"jobTitle"')) {
                console.log(`Found potential job data in script ${index}`);
                
                try {
                    // Try to find JSON structure with job data
                    // Look for patterns like "jobtitle":"..." or "company":"..."
                    const jobMatches = content.match(/"job[tT]itle":"([^"]+)"/g);
                    const companyMatches = content.match(/"company":"([^"]+)"/g);
                    const overviewMatches = content.match(/"companyOverviewLink":"([^"]+)"/g);
                    
                    if (jobMatches && companyMatches) {
                        const numJobs = Math.min(jobMatches.length, companyMatches.length);
                        for (let i = 0; i < numJobs; i++) {
                            const jobTitle = jobMatches[i].match(/"job[tT]itle":"([^"]+)"/)[1];
                            const company = companyMatches[i].match(/"company":"([^"]+)"/)[1];
                            let companyLink = null;
                            
                            if (overviewMatches && overviewMatches[i]) {
                                const link = overviewMatches[i].match(/"companyOverviewLink":"([^"]+)"/)[1];
                                // Clean up the link
                                if (link.startsWith('/cmp/')) {
                                    companyLink = `https://www.indeed.com${link}`;
                                } else {
                                    companyLink = link
                                        .replace(/\\u002F/g, '/')
                                        .replace(/\\\//g, '/')
                                        .replace(/\\/g, '');
                                }
                            }
                            
                            jobDataFromScripts.push({
                                job_title: jobTitle.replace(/\\u[0-9a-fA-F]{4}/g, ''),  // Remove unicode escapes
                                job_company: company.replace(/\\u[0-9a-fA-F]{4}/g, ''),
                                companyOverviewLink: companyLink
                            });
                        }
                    }
                    
                    // Alternative: Look for window._initialData or similar
                    const dataMatch = content.match(/window\._initialData\s*=\s*({.+?});/s);
                    if (dataMatch) {
                        try {
                            const data = JSON.parse(dataMatch[1]);
                            // Navigate through the data structure to find jobs
                            if (data.resultsListData && data.resultsListData.results) {
                                data.resultsListData.results.forEach(job => {
                                    jobDataFromScripts.push({
                                        job_title: job.title || job.jobtitle,
                                        job_company: job.company,
                                        companyOverviewLink: job.companyOverviewLink ? 
                                            `https://www.indeed.com${job.companyOverviewLink}` : null
                                    });
                                });
                            }
                        } catch (e) {
                            console.log('Could not parse _initialData:', e.message);
                        }
                    }
                } catch (e) {
                    console.log('Error parsing script content:', e.message);
                }
            }
        }
    });
    
    // Method 2: Try DOM-based extraction with multiple selectors
    const jobSelectors = [
        // Current selectors
        'h2.jobTitle',
        'h2[class*="jobTitle"]',
        '[data-testid="job-card"]',
        '[class*="job_seen_beacon"]',
        '[class*="jobsearch-SerpJobCard"]',
        '[class*="job-card"]',
        // Legacy selectors
        '.jobsearch-SerpJobCard',
        '.job_seen_beacon',
        '[data-jk]',  // Job key attribute
        'a[data-testid="job-title"]',
        '.jobTitle a',
        'span[title]'  // Title spans within job cards
    ];
    
    for (const selector of jobSelectors) {
        const elements = doc.querySelectorAll(selector);
        if (elements.length > 0) {
            console.log(`Found ${elements.length} elements with selector: ${selector}`);
            
            elements.forEach(element => {
                const job = {
                    job_title: null,
                    job_company: null,
                    companyOverviewLink: null
                };
                
                // Try to find job title
                const titleSelectors = [
                    'h2 span[title]',
                    'h2 a span',
                    'a[data-testid="job-title"]',
                    '.jobTitle',
                    '[class*="jobTitle"]',
                    'a span[title]'
                ];
                
                for (const titleSel of titleSelectors) {
                    const titleEl = element.querySelector(titleSel) || 
                                   (element.matches(titleSel) ? element : null);
                    if (titleEl) {
                        job.job_title = titleEl.getAttribute('title') || titleEl.textContent.trim();
                        if (job.job_title) break;
                    }
                }
                
                // Try to find company name
                const companySelectors = [
                    '[data-testid="company-name"]',
                    '.companyName',
                    '[class*="companyName"]',
                    'div[class*="company"]',
                    'span[class*="company"]'
                ];
                
                for (const companySel of companySelectors) {
                    const companyEl = element.querySelector(companySel);
                    if (companyEl) {
                        job.job_company = companyEl.textContent.trim();
                        if (job.job_company) break;
                    }
                }
                
                // Try to find company overview link
                const linkEl = element.querySelector('a[href*="/cmp/"]');
                if (linkEl) {
                    job.companyOverviewLink = `https://www.indeed.com${linkEl.getAttribute('href')}`;
                }
                
                // Only add if we found at least title or company
                if (job.job_title || job.job_company) {
                    results.push(job);
                }
            });
            
            if (results.length > 0) break; // Stop if we found jobs
        }
    }
    
    // Use script data if DOM extraction failed
    if (results.length === 0 && jobDataFromScripts.length > 0) {
        console.log("Using data extracted from scripts");
        results.push(...jobDataFromScripts);
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

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const authToken = req.headers.authentication;

    if (!authToken || !isValidToken(authToken)) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid or missing token" });
    }

    try {
        const { keyword, location, company_details, extra } = req.body;
        console.log('Search parameters:', { keyword, location, company_details, extra });
        
        if (!keyword || !location) {
            return res.status(400).json({ 
                error: 'Keyword and location are required in the request body' 
            });
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
            return res.status(500).json({ 
                error: 'Failed to scrape Indeed - the site may be blocking requests',
                message: 'Indeed may require additional authentication or is blocking scraping attempts'
            });
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
            
            // Limit pages to avoid excessive scraping
            const maxPages = Math.min(totalPages, 3); // Limit to 3 pages max
            
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
        if (company_details && allJobs.length > 0) {
            console.log('\nStarting company overview scraping...');
            
            // Limit company detail fetching to first 10 jobs to avoid rate limiting
            const jobsToProcess = allJobs.slice(0, 10);
            
            finalJobs = await Promise.all(jobsToProcess.map(async (job, index) => {
                console.log(`\nProcessing company overview for job ${index + 1} of ${jobsToProcess.length}`);
                let cleanedJob = { ...job };
                
                if (job.companyOverviewLink) {
                    const withoutQuery = job.companyOverviewLink.split('?')[0];
                    const cleanedUrl = withoutQuery
                        .replace(/\\u002F/g, '/')
                        .replace(/\\\//g, '/')
                        .replace(/\\/g, '');
                    
                    cleanedJob.companyOverviewLink = cleanedUrl;
                    console.log(`Company overview URL for job ${index + 1}:`, cleanedUrl);
                    
                    const { industry, websiteUrl } = await scrapeCompanyOverview(cleanedUrl);
                    
                    if (industry) cleanedJob.industry = industry;
                    if (websiteUrl) cleanedJob.websiteUrl = websiteUrl;
                }
                
                return cleanedJob;
            }));
            
            // Add remaining jobs without company details
            if (allJobs.length > 10) {
                finalJobs.push(...allJobs.slice(10));
            }
        } else if (!company_details) {
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

        // Save to KV store
        try {
            const tokenIndex = getValidTokens().indexOf(authToken);
            const timestamp = new Date().toISOString();
            
            await kv.set(`indeed:count:${tokenIndex + 1}:${timestamp}`, {
                count: finalJobs.length,
                total_number_of_jobs: firstPageJobs.total_number_of_jobs,
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

        res.json(responseData);

    } catch (error) {
        console.error('Error scraping job info:', error);
        res.status(500).json({ 
            error: 'Failed to scrape job information',
            message: error.message 
        });
    }
}
