const axios = require('axios');
const fs = require('fs');

const GOOGLE_VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.OCR_API_KEY}`;

const getTextFromImage = async (imagePath) => {
    const imageFile = fs.readFileSync(imagePath);
    const encodedImage = Buffer.from(imageFile).toString('base64');

    const requestBody = {
        requests: [{
            image: { content: encodedImage },
            features: [{ type: 'TEXT_DETECTION' }]
        }]
    };

    const response = await axios.post(GOOGLE_VISION_API_URL, requestBody);
    
    if (response.data.responses[0]?.fullTextAnnotation?.text) {
        return response.data.responses[0].fullTextAnnotation.text;
    }
    throw new Error('Could not extract text from image.');
};

const parseChequeText = (text) => {
    const data = {
        payeeName: 'N/A',
        amount: 0,
        amountInWords: 'N/A',
        chequeDate: 'N/A',
        micr: { chequeNo: 'N/A', bankCode: 'N/A', branchCode: 'N/A', payerAccountNo: 'N/A' },
        needsReview: false,
        reviewNotes: [],
    };

    // 1. Parse Date (DDMMYY format)
    const dateRegex = /(\d{2})\s*(\d{2})\s*(\d{2,4})/;
    const dateMatch = text.match(dateRegex);
    if (dateMatch) {
        data.chequeDate = `${dateMatch[1]}-${dateMatch[2]}-20${dateMatch[3]}`; // Assuming YY format
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse date.");
    }

    const amountRegex = /RM\s*([\d,]+\.\d{2})/;
    const amountMatch = text.match(amountRegex);
    if (amountMatch && amountMatch[1]) {
        data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in figures.");
    }

    const payeeRegex = /PAY\s*([^\n]+)/;
    const payeeMatch = text.match(payeeRegex);
    if (payeeMatch && payeeMatch[1]) {
        data.payeeName = payeeMatch[1].trim();
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name.");
    }

    const amountWordsRegex = /RINGGIT\s*MALAYSIA\/.*?([A-Z\s]+?)\s*ONLY/;
    const amountWordsMatch = text.match(amountWordsRegex);
    if (amountWordsMatch && amountWordsMatch[1]) {
        data.amountInWords = amountWordsMatch[1].trim().replace(/\s+/g, ' ');
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in words.");
    }
    
    const micrRegex = /⑆\s*(\d+)\s*⑈\s*(\d+)\s*⑆\s*(\d+)\s*⑈/;
    const micrMatch = text.match(micrRegex);
    if (micrMatch) {
        data.micr.chequeNo = micrMatch[1];
        const bankBranch = micrMatch[2];
        data.micr.bankCode = bankBranch.substring(0, 2); 
        data.micr.branchCode = bankBranch.substring(2); 
        data.micr.payerAccountNo = micrMatch[3];
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse MICR line.");
    }

    return data;
};

module.exports = { getTextFromImage, parseChequeText };