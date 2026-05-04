// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init();

// Structure of input is defined in input_schema.json
const { 
    startUrls = ['https://www.amazon.com/s?k=wireless+headphones'], 
    maxRequestsPerCrawl = 50,
    maxReviewsPerProduct = 500,
    minReviewRating = 1,
    minReviewLength = 20,
    reviewLanguage = 'en',
    enableAISummarization = true,
    sentimentAnalysisMethod = 'advanced',
    groupSimilarIssues = true,
    minFrequencyThreshold = 3,
    includeExamples = true
} = (await Actor.getInput()) ?? {};

// Proxy configuration to rotate IP addresses and prevent blocking
const proxyConfiguration = await Actor.createProxyConfiguration();

// Store to track analyzed products
const kvStore = await KeyValueStore.open();
const previousAnalysis = (await kvStore.getValue('previousAnalysis')) || {};

const log = Actor.getLogger();

// Track sentiment analysis
const sentimentResults = [];
const prosAndConsData = [];
const detailedAnalysisData = [];

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, log }) {
        log.info('Processing e-commerce page:', { url: request.loadedUrl });

        try {
            // Determine which retailer we're scraping
            const isAmazon = request.loadedUrl.includes('amazon.com');
            const isEbay = request.loadedUrl.includes('ebay.com');
            
            if (isAmazon) {
                scrapeAmazonReviews($, log, request.loadedUrl);
            } else if (isEbay) {
                scrapeEbayReviews($, log, request.loadedUrl);
            } else {
                scrapeGenericProductReviews($, log, request.loadedUrl);
            }
        } catch (error) {
            log.error('Error processing page:', { 
                url: request.loadedUrl,
                error: error.message 
            });
        }
    },
    
    errorHandler: async ({ request, error, log }) => {
        log.warning('Request failed:', { 
            url: request.loadedUrl,
            error: error.message 
        });
    },
});

async function scrapeAmazonReviews($, log, pageUrl) {
    // Extract product information
    const productName = $('span[id="productTitle"]').text().trim() || 
                       $('h1 span').text().trim() || 'Unknown Product';
    const productUrl = pageUrl;
    
    // Simulate review extraction (In production, you'd paginate through reviews)
    const reviews = [];
    
    $('div[data-hook="review"], div.a-section.a-spacing-none.reviews-content-padding').each((index, element) => {
        if (index >= maxReviewsPerProduct) return false;
        
        const $review = $(element);
        const ratingText = $review.find('span[data-rating]').attr('data-rating') || 
                          $review.find('a.a-star-small span').text().trim() || '3';
        const rating = parseInt(ratingText.split(' ')[0]) || 3;
        
        const title = $review.find('a.review-title-content span').text().trim() || 'N/A';
        const body = $review.find('span[data-hook="review-body"] span').text().trim() || '';
        
        if (body.length < minReviewLength) return;
        if (rating < minReviewRating) return;
        
        reviews.push({
            title,
            body,
            rating,
            helpful: extractHelpfulCount($review),
            verified: $review.find('[data-hook="avp-verified-purchase-badge"]').length > 0
        });
    });

    if (reviews.length === 0) {
        log.warning('No reviews found for product:', { productName });
        return;
    }

    // Analyze reviews
    await analyzeProductReviews({
        productName,
        productUrl,
        reviews,
        log
    });
}

async function scrapeEbayReviews($, log, pageUrl) {
    const productName = $('h1.it-title span').text().trim() || 
                       $('.vi-content h1').text().trim() || 'Unknown Product';
    const productUrl = pageUrl;
    
    const reviews = [];
    
    $('div.review-item, div[class*="review"]').each((index, element) => {
        if (index >= maxReviewsPerProduct) return false;
        
        const $review = $(element);
        const ratingText = $review.find('.star-rating').attr('class') || '3 star';
        const rating = parseInt(ratingText.match(/\d+/)[0]) || 3;
        
        const body = $review.find('.review-text, .review-content').text().trim() || '';
        const title = $review.find('.review-title, .review-header').text().trim() || 'N/A';
        
        if (body.length < minReviewLength) return;
        if (rating < minReviewRating) return;
        
        reviews.push({
            title,
            body,
            rating,
            helpful: 0,
            verified: true
        });
    });

    if (reviews.length === 0) {
        log.warning('No reviews found for product:', { productName });
        return;
    }

    await analyzeProductReviews({
        productName,
        productUrl,
        reviews,
        log
    });
}

async function scrapeGenericProductReviews($, log, pageUrl) {
    const productName = $('h1').first().text().trim() || 
                       $('title').text().trim() || 'Unknown Product';
    const productUrl = pageUrl;
    
    const reviews = [];
    
    $('[class*="review"], [data-testid*="review"]').each((index, element) => {
        if (index >= maxReviewsPerProduct) return false;
        
        const $review = $(element);
        const ratingText = $review.find('[class*="rating"], [class*="star"]').attr('data-rating') || '3';
        const rating = parseInt(ratingText.split(' ')[0]) || 3;
        
        const body = $review.find('[class*="review-body"], [class*="review-text"]').text().trim() || '';
        const title = $review.find('[class*="review-title"]').text().trim() || 'N/A';
        
        if (body.length < minReviewLength) return;
        if (rating < minReviewRating) return;
        
        reviews.push({
            title,
            body,
            rating,
            helpful: 0,
            verified: false
        });
    });

    if (reviews.length === 0) {
        log.warning('No reviews found for product:', { productName });
        return;
    }

    await analyzeProductReviews({
        productName,
        productUrl,
        reviews,
        log
    });
}

async function analyzeProductReviews(data) {
    const { productName, productUrl, reviews, log } = data;
    
    const productKey = productName.toLowerCase();
    const currentTimestamp = new Date().toISOString();

    log.info(`Analyzing ${reviews.length} reviews for: ${productName}`);

    // Calculate sentiment distribution
    const sentimentDist = {
        positive: reviews.filter(r => r.rating >= 4).length,
        neutral: reviews.filter(r => r.rating === 3).length,
        negative: reviews.filter(r => r.rating <= 2).length
    };

    const totalReviews = reviews.length;
    const positivePercent = ((sentimentDist.positive / totalReviews) * 100).toFixed(1);
    const negativePercent = ((sentimentDist.negative / totalReviews) * 100).toFixed(1);
    const averageRating = (reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(2);
    
    // Calculate sentiment score (-1 to 1)
    const sentimentScore = ((sentimentDist.positive - sentimentDist.negative) / totalReviews).toFixed(3);

    // Extract pros and cons
    const { pros, cons } = extractProsAndCons(reviews, productName, log);

    // Push sentiment summary
    await Dataset.pushData({
        productName,
        positiveReviewCount: sentimentDist.positive,
        negativeReviewCount: sentimentDist.negative,
        neutralReviewCount: sentimentDist.neutral,
        positivePercentage: parseFloat(positivePercent),
        negativePercentage: parseFloat(negativePercent),
        sentimentScore: parseFloat(sentimentScore)
    });

    // Push pros and cons data
    for (const pro of pros) {
        await Dataset.pushData({
            productName,
            prosAndConsType: 'Pro',
            item: pro.text,
            frequency: pro.frequency,
            percentage: ((pro.frequency / totalReviews) * 100).toFixed(1),
            example: includeExamples ? pro.example : 'N/A'
        });
    }

    for (const con of cons) {
        await Dataset.pushData({
            productName,
            prosAndConsType: 'Con',
            item: con.text,
            frequency: con.frequency,
            percentage: ((con.frequency / totalReviews) * 100).toFixed(1),
            example: includeExamples ? con.example : 'N/A'
        });
    }

    // Push overview
    await Dataset.pushData({
        productName,
        productUrl,
        totalReviewsAnalyzed: totalReviews,
        averageRating: parseFloat(averageRating),
        overallSentiment: sentimentScore > 0 ? 'Positive' : sentimentScore < 0 ? 'Negative' : 'Neutral',
        prosCount: pros.length,
        consCount: cons.length
    });

    // Calculate category scores
    const qualityScore = calculateQualityScore(reviews);
    const valueScore = calculateValueScore(reviews);
    const deliveryScore = calculateDeliveryScore(reviews);

    // Push detailed analysis
    await Dataset.pushData({
        productName,
        category: extractProductCategory(productName),
        topPro: pros.length > 0 ? pros[0].text : 'N/A',
        topCon: cons.length > 0 ? cons[0].text : 'N/A',
        qualityScore,
        valueScore,
        deliveryScore,
        overallRecommendation: determineRecommendation(sentimentScore, averageRating, pros.length, cons.length)
    });

    log.info(`Analysis complete for ${productName}`, {
        reviews: totalReviews,
        sentiment: sentimentScore,
        pros: pros.length,
        cons: cons.length
    });

    // Track in previous analysis
    previousAnalysis[productKey] = {
        productName,
        reviewsAnalyzed: totalReviews,
        sentimentScore,
        analyzedAt: currentTimestamp
    };
}

function extractProsAndCons(reviews, productName, log) {
    const pros = {};
    const cons = {};

    // Common pro and con patterns
    const proPatterns = [
        /great|excellent|amazing|love|perfect|best|fantastic|awesome|wonderful|highly recommend|very good|worth|good quality|well made|durable|reliable|fast|quick|easy|simple|comfortable|effective|exactly what i needed|better than expected/gi,
        /really good|exactly as described|highly satisfied|impressed|great value|good product/gi
    ];

    const conPatterns = [
        /poor|bad|terrible|hate|worst|broken|defective|stopped working|doesn't work|cheap|flimsy|uncomfortable|difficult|hard to use|complicated|waste of money|disappointed|disappointed with|not recommended|problems with|issue with|quality issue/gi,
        /doesn't fit|doesn't match description|false advertising|overpriced|not worth|poor quality|cheap quality/gi
    ];

    for (const review of reviews) {
        const reviewText = `${review.title} ${review.body}`.toLowerCase();

        // Extract pros
        proPatterns.forEach(pattern => {
            const matches = reviewText.match(pattern);
            if (matches) {
                matches.forEach(match => {
                    const pro = normalizeTerm(match);
                    pros[pro] = (pros[pro] || 0) + 1;
                    if (!pros[`${pro}_example`]) {
                        pros[`${pro}_example`] = extractQuote(review.body, match);
                    }
                });
            }
        });

        // Extract cons
        conPatterns.forEach(pattern => {
            const matches = reviewText.match(pattern);
            if (matches) {
                matches.forEach(match => {
                    const con = normalizeTerm(match);
                    cons[con] = (cons[con] || 0) + 1;
                    if (!cons[`${con}_example`]) {
                        cons[`${con}_example`] = extractQuote(review.body, match);
                    }
                });
            }
        });
    }

    // Filter by frequency threshold and group similar issues
    const prosArray = Object.entries(pros)
        .filter(([key, count]) => !key.endsWith('_example') && count >= minFrequencyThreshold)
        .map(([text, frequency]) => ({
            text,
            frequency,
            example: pros[`${text}_example`] || 'N/A'
        }))
        .sort((a, b) => b.frequency - a.frequency);

    const consArray = Object.entries(cons)
        .filter(([key, count]) => !key.endsWith('_example') && count >= minFrequencyThreshold)
        .map(([text, frequency]) => ({
            text,
            frequency,
            example: cons[`${text}_example`] || 'N/A'
        }))
        .sort((a, b) => b.frequency - a.frequency);

    // Group similar issues if enabled
    if (groupSimilarIssues) {
        return {
            pros: groupSimilarTerms(prosArray),
            cons: groupSimilarTerms(consArray)
        };
    }

    return { pros: prosArray, cons: consArray };
}

function normalizeTerm(term) {
    return term.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

function extractQuote(text, keyword) {
    const index = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (index === -1) return 'N/A';
    
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + keyword.length + 50);
    return `"...${text.substring(start, end)}..."`;
}

function groupSimilarTerms(terms) {
    const grouped = [];
    const used = new Set();

    for (const term of terms) {
        if (used.has(term.text)) continue;

        let merged = { ...term };
        
        for (const other of terms) {
            if (used.has(other.text) || term.text === other.text) continue;
            
            if (areSimilar(term.text, other.text)) {
                merged.frequency += other.frequency;
                used.add(other.text);
            }
        }
        
        grouped.push(merged);
        used.add(term.text);
    }

    return grouped.sort((a, b) => b.frequency - a.frequency);
}

function areSimilar(term1, term2) {
    const similarity = calculateLevenshteinSimilarity(term1, term2);
    return similarity > 0.7;
}

function calculateLevenshteinSimilarity(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));

    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;

    for (let j = 1; j <= len2; j++) {
        for (let i = 1; i <= len1; i++) {
            const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + indicator
            );
        }
    }

    const maxLen = Math.max(len1, len2);
    return 1 - (matrix[len2][len1] / maxLen);
}

function calculateQualityScore(reviews) {
    const qualityKeywords = ['quality', 'durable', 'well made', 'excellent', 'broken', 'defective', 'cheap'];
    let score = 0;

    for (const review of reviews) {
        const text = `${review.title} ${review.body}`.toLowerCase();
        if (qualityKeywords.some(kw => text.includes(kw))) {
            score += review.rating > 3 ? 1 : -0.5;
        }
    }

    return Math.min(5, Math.max(1, 3 + (score / reviews.length)));
}

function calculateValueScore(reviews) {
    const valueKeywords = ['price', 'value', 'worth', 'expensive', 'cheap', 'overpriced'];
    let score = 0;

    for (const review of reviews) {
        const text = `${review.title} ${review.body}`.toLowerCase();
        if (valueKeywords.some(kw => text.includes(kw))) {
            score += review.rating > 3 ? 1 : -0.5;
        }
    }

    return Math.min(5, Math.max(1, 3 + (score / reviews.length)));
}

function calculateDeliveryScore(reviews) {
    const deliveryKeywords = ['shipping', 'delivery', 'fast', 'slow', 'packaging', 'damaged in transit'];
    let score = 0;

    for (const review of reviews) {
        const text = `${review.title} ${review.body}`.toLowerCase();
        if (deliveryKeywords.some(kw => text.includes(kw))) {
            score += review.rating > 3 ? 1 : -0.5;
        }
    }

    return Math.min(5, Math.max(1, 3 + (score / reviews.length)));
}

function extractProductCategory(productName) {
    const categories = {
        'electronics': ['phone', 'laptop', 'headphones', 'speaker', 'camera', 'tablet'],
        'fashion': ['shirt', 'pants', 'dress', 'shoes', 'jacket', 'sweater'],
        'home': ['pillow', 'blanket', 'lamp', 'rug', 'furniture', 'bedding'],
        'sports': ['ball', 'racket', 'weights', 'yoga', 'bike'],
        'beauty': ['lotion', 'shampoo', 'makeup', 'cream', 'serum']
    };

    const lowerName = productName.toLowerCase();
    for (const [category, keywords] of Object.entries(categories)) {
        if (keywords.some(kw => lowerName.includes(kw))) {
            return category.charAt(0).toUpperCase() + category.slice(1);
        }
    }

    return 'General';
}

function determineRecommendation(sentimentScore, averageRating, prosCount, consCount) {
    const sentiment = parseFloat(sentimentScore);
    const rating = parseFloat(averageRating);

    if (rating >= 4.5 && sentiment > 0.5 && prosCount > consCount) {
        return 'Highly Recommended';
    } else if (rating >= 4.0 && sentiment > 0) {
        return 'Recommended';
    } else if (rating >= 3.0 && sentiment >= 0) {
        return 'Consider';
    } else if (rating >= 2.0) {
        return 'Caution';
    } else {
        return 'Not Recommended';
    }
}

function extractHelpfulCount($review) {
    const helpfulText = $review.find('[data-hook="helpful-vote-statement-post-purchase"]').text().trim() || '0';
    const match = helpfulText.match(/(\d+)/);
    return match ? parseInt(match[1]) : 0;
}

await crawler.run(startUrls);

// Save updated analysis for next run
await kvStore.setValue('previousAnalysis', previousAnalysis);

log.info('Review sentiment analysis completed', {
    productsAnalyzed: Object.keys(previousAnalysis).length,
    totalDataPoints: sentimentResults.length + prosAndConsData.length + detailedAnalysisData.length
});

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();