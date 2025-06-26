const Cheque = require('../models/Cheque');
const { processCheque } = require('../services/ocrService');
const fs = require('fs');
const axios = require('axios');

const autosaveChequeData = async (req, res) => {
    try {
        const { id } = req.params;
        const autosaveData = req.body;
        const cheque = await Cheque.findByIdAndUpdate(id, autosaveData, { new: true });

        if (!cheque) {
            return res.status(404).json({ message: 'Cheque not found for autosave.' });
        }
        res.status(200).json({ message: 'Autosaved successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error during autosave.' });
    }
};

const processNewCheque = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file uploaded.' });
    }

    try {
        const extractedData = await processCheque(req.file.path);

        const newCheque = new Cheque({
            ...extractedData,
            imageUrl: req.file.filename,
        });

        await newCheque.save();

        if (newCheque.needsReview && process.env.N8N_WEBHOOK_URL) {
            try {
                await axios.post(process.env.N8N_WEBHOOK_URL, newCheque.toJSON());
            } catch (error) {
                console.error("Failed to trigger n8n webhook:", error.message);
            }
        }
        
        // IMPORTANT CHANGE:
        // The rawText is now part of the JSON response you get back.
        // You can inspect this text to see what the OCR engine extracted.
        res.status(201).json({
            chequeData: newCheque,
            rawOcrText: extractedData.rawText // <--- THIS LINE IS ADDED FOR YOU TO DEBUG
        });

    } catch (error) {
        console.error('*** CHEQUE PROCESSING ERROR ***:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ 
            message: 'Server error during cheque processing.', 
            error: error.message,
            // Also include raw text in the error response if it's available
            rawOcrText: error.rawText || "Could not be retrieved." 
        });
    }
};

const getReviewCheques = async (req, res) => {
    try {
        const cheques = await Cheque.find({ needsReview: true, status: 'Processed' });
        res.status(200).json(cheques);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching cheques for review.' });
    }
};

const updateChequeData = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;

        const cheque = await Cheque.findByIdAndUpdate(id, {
            ...updatedData,
            needsReview: false, 
            reviewNotes: [], 
            status: 'Reviewed'
        }, { new: true }); 

        if (!cheque) {
            return res.status(404).json({ message: 'Cheque not found.' });
        }
        res.status(200).json(cheque);
    } catch (error) {
        res.status(500).json({ message: 'Server error updating cheque data.' });
    }
};

module.exports = { processNewCheque, getReviewCheques, updateChequeData, autosaveChequeData };