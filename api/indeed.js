import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import { stringify } from 'querystring';
import { kv } from '@vercel/kv';

async function totalNumberOfPages(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract total number of jobs
    let totalNumberOfJobs = "0";
    const jobCountElement = doc.querySelector('.jobsearch-JobCountAndSortPane-jobCount');
    if (jobCountElement) {
        const jobCountText = jobCountElement.textContent;
        // Extract just the number from strings like "2 jobs"
        const matches = jobCountText.match(/\d+/);
        if (matches) {
            totalNumberOfJobs = matches[0];
        }
    }

    // Return the total number of jobs divided by 15
    return Math.ceil(totalNumberOfJobs / 15);
}

async function extractJobInfo(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const results = [];

    console.log("we are extracting the job info");

    // return the first 2k characters of the html
    console.log(html.substring(0, 2000));

    // Extract total number of jobs
    let totalNumberOfJobs = "0";
    const jobCountElement = doc.querySelector('.jobsearch-JobCountAndSortPane-jobCount');
    if (jobCountElement) {
        const jobCountText = jobCountElement.textContent;
        // Extract just the number from strings like "2 jobs"
        const matches = jobCountText.match(/\d+/);
        if (matches) {
            totalNumberOfJobs = matches[0];
        }
    }
    console.log("Total number of jobs found:", totalNumberOfJobs);
    
    // Find all job title h2 elements
    const jobTitleH2s = doc.querySelectorAll('h2.jobTitle.css-1psdjh5');
    console.log("we found", jobTitleH2s.length, "job title h2 elements");
    
    // Find all script tags that might contain the job data
    const scripts = doc.querySelectorAll('script');
    console.log("Found", scripts.length, "script tags");
    
    let jobData = [];
    
    // Look for the script that contains the job data
    scripts.forEach((script, index) => {
        const content = script.textContent;
        console.log(`Script ${index} content length:`, content.length);
        
        if (content.includes('companyOverviewLink')) {
            console.log(`Found companyOverviewLink in script ${index}`);
            try {
                // Look for the pattern "companyOverviewLink":"/cmp/..."
                const matches = content.match(/"companyOverviewLink":"([^"]+)"/g);
                if (matches) {
                    console.log("Found matches:", matches);
                    matches.forEach(match => {
                        const link = match.match(/"companyOverviewLink":"([^"]+)"/)[1];
                        console.log("Extracted link:", link);
                        // Handle both relative and full URLs
                        let fullLink;
                        if (link.startsWith('/cmp/')) {
                            fullLink = `https://www.indeed.com${link}`;
                        } else if (link.includes('/cmp/')) {
                            // Remove @ prefix if present
                            const cleanLink = link.replace(/^@/, '');
                            // Remove query parameters
                            const withoutQuery = cleanLink.split('?')[0];
                            // Replace Unicode escape sequences and clean up
                            const finalUrl = withoutQuery
                                .replace(/u002F/g, '/')     // Replace u002F with /
                                .replace(/\\\/\\\//g, '//')  // Replace \/\/ with //
                                .replace(/\\\//g, '/')      // Replace \/ with /
                                .replace(/\\/g, '');        // Remove any remaining backslashes
                            fullLink = finalUrl;
                        } else {
                            fullLink = link;
                        }
                        jobData.push({ companyOverviewLink: fullLink });
                    });
                } else {
                    console.log("No matches found in script content");
                }
            } catch (e) {
                console.log('Error parsing script content:', e);
            }
        }
    });
    
    console.log("Total job data found:", jobData.length);
    
    jobTitleH2s.forEach((jobTitleH2, index) => {
        const result = {
            job_title: null,
            job_company: null,
            companyOverviewLink: index < jobData.length ? jobData[index].companyOverviewLink : null
        };
        
        // Get job title from the span within h2
        const titleSpan = jobTitleH2.querySelector('span[title][id]');
        if (titleSpan) {
            result.job_title = titleSpan.textContent;
        }
        
        // Find the closest parent that contains both the job title and company info
        const jobCard = jobTitleH2.closest('[class*="job_seen_beacon"]');
        if (jobCard) {
            // Find company name within this job card
            const companySpan = jobCard.querySelector('span[data-testid="company-name"]');
            if (companySpan) {
                result.job_company = companySpan.textContent;
            }
        }
        
        // Only add the result if at least one field was found
        if (result.job_title || result.job_company) {
            results.push(result);
        }
    });
    
    console.log("Final results:", JSON.stringify(results, null, 2));
    
    return {
        jobs: results,
        total_number_of_jobs: totalNumberOfJobs
    };
}
 

export function generateIndeedUrls(keyword, location, page_number, premium = false) {
    // Prepare the base Indeed search URL
    const baseUrl = "https://www.indeed.com/jobs";
    console.log("we are starting the indeed search using the variables", keyword, location);

    // Create query parameters
    const params = {
        q: keyword,     // Search keyword
        l: location,    // Location
        radius: "0",     // Default radius of 0 miles
        start: page_number * 10 // This should appear only from page_number 1 onwards
    };

    // Generate the original Indeed search URL
    const originalUrl = `${baseUrl}?${stringify(params)}`;
    console.log(originalUrl);

    // Scraper API key (you may want to replace this with a secure method of storing API keys)
    const scraperApiKey = "de3bfafaa930e82099f66a7ab7bb18fe";

    // Generate the ScraperAPI URL with optional premium parameter
    const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(originalUrl)}${premium ? '&premium=true' : ''}`;
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

// Add token counter system
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
        const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(companyUrl)}`;
        console.log('ScraperAPI URL for company overview:', scraperUrl);
        
        const response = await fetch(scraperUrl);
        console.log('ScraperAPI response status for company overview:', response.status);
        const html = await response.text();
        console.log('Raw HTML from company overview (first 1000 chars):', html.substring(0, 1000));
        
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        
        // Find all script tags
        const scripts = doc.querySelectorAll('script');
        console.log('Number of script tags found:', scripts.length);
        
        let industry = null;
        let websiteUrl = null;
        
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
                const websiteMatch = content.match(/"websiteUrl":{"text":"[^"]+","url":"([^"]+)"}/);
                if (websiteMatch) {
                    websiteUrl = websiteMatch[1];
                    console.log('Found website URL:', websiteUrl);
                }
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

        // Use ScraperAPI to fetch the HTML
        let response = await fetch(scraperUrl);
        console.log('Initial ScraperAPI response status:', response.status);
        
        // If we get a 500 status, retry with premium=true
        if (response.status === 500) {
            console.log('Received 500 status, retrying with premium=true');
            const { scraperUrl: premiumUrl } = generateIndeedUrls(keyword, location, 0, true);
            console.log('Retry ScraperAPI URL with premium:', premiumUrl);
            response = await fetch(premiumUrl);
            console.log('Premium ScraperAPI response status:', response.status);
        }
        
        const html = await response.text();
        console.log('Raw HTML from first page (first 1000 chars):', html.substring(0, 1000));
        
        // Extract job information from the scraped HTML
        const firstPageJobs = await extractJobInfo(html);
        console.log('First page jobs extracted:', JSON.stringify(firstPageJobs, null, 2));
        
        const totalPages = await totalNumberOfPages(html);
        console.log('Total pages found:', totalPages);

        const allJobs = [...firstPageJobs.jobs]; // Start with first page jobs

        // Increment counter for first page
        incrementTokenCounter(authToken);

        // go through each page and extract the job info
        for (let i = 1; i < totalPages; i++) {
            console.log(`\nProcessing page ${i + 1} of ${totalPages}`);
            const { scraperUrl } = generateIndeedUrls(keyword, location, i);
            console.log(`ScraperAPI URL for page ${i + 1}:`, scraperUrl);
            
            const response = await fetch(scraperUrl);
            console.log(`ScraperAPI response status for page ${i + 1}:`, response.status);
            const html = await response.text();
            console.log(`Raw HTML from page ${i + 1} (first 1000 chars):`, html.substring(0, 1000));
            
            const pageJobs = await extractJobInfo(html);
            console.log(`Jobs extracted from page ${i + 1}:`, JSON.stringify(pageJobs, null, 2));
            
            allJobs.push(...pageJobs.jobs);
            
            // Increment counter for each additional page
            incrementTokenCounter(authToken);
        }

        let finalJobs = allJobs;

        // Only process company details if company_details is true
        if (company_details) {
            console.log('\nStarting company overview scraping...');
            // Clean up URLs and fetch company overview data
            finalJobs = await Promise.all(allJobs.map(async (job, index) => {
                console.log(`\nProcessing company overview for job ${index + 1} of ${allJobs.length}`);
                let cleanedJob = { ...job };
                
                if (job.companyOverviewLink) {
                    // Remove query parameters
                    const withoutQuery = job.companyOverviewLink.split('?')[0];
                    // Replace Unicode escape sequences and clean up
                    const cleanedUrl = withoutQuery
                        .replace(/u002F/g, '/')     // Replace u002F with /
                        .replace(/\\\/\\\//g, '//')  // Replace \/\/ with //
                        .replace(/\\\//g, '/')       // Replace \/ with /
                        .replace(/\\/g, '');         // Remove any remaining backslashes
                    
                    cleanedJob.companyOverviewLink = cleanedUrl;
                    console.log(`Company overview URL for job ${index + 1}:`, cleanedUrl);
                    
                    // Fetch company overview data
                    const { industry, websiteUrl } = await scrapeCompanyOverview(cleanedUrl);
                    console.log(`Company overview data for job ${index + 1}:`, { industry, websiteUrl });
                    
                    if (industry) {
                        cleanedJob.industry = industry;
                    }
                    if (websiteUrl) {
                        cleanedJob.websiteUrl = websiteUrl;
                    }
                }
                
                return cleanedJob;
            }));
        } else {
            // If company_details is false, only keep job_title and job_company
            finalJobs = allJobs.map(job => ({
                job_title: job.job_title,
                job_company: job.job_company
            }));
        }

        console.log('\nFinal processed jobs:', JSON.stringify(finalJobs, null, 2));

        const responseData = {
            count: finalJobs.length,
            total_number_of_jobs: firstPageJobs.total_number_of_jobs,
            jobs: finalJobs,
            pages_scraped: getTokenCounter(authToken)
        };

        // Add extra field to response if it exists
        if (extra) {
            responseData.extra = extra;
        }

        // Save the count and job data to KV store
        try {
            const tokenIndex = getValidTokens().indexOf(authToken);
            const timestamp = new Date().toISOString();
            
            // Save the count and basic info
            await kv.set(`indeed:count:${tokenIndex + 1}:${timestamp}`, {
                count: finalJobs.length,
                total_number_of_jobs: firstPageJobs.total_number_of_jobs,
                pages_scraped: getTokenCounter(authToken),
                keyword,
                location,
                timestamp
            });

            // Save the full job data
            await kv.set(`indeed:jobs:${tokenIndex + 1}:${timestamp}`, {
                jobs: finalJobs,
                extra: extra || null
            });

            // Increment the total count for this token
            await kv.incr(`indeed:total_count:token${tokenIndex + 1}`);
        } catch (error) {
            console.error('Error saving to KV store:', error);
            // Continue with the response even if saving fails
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
