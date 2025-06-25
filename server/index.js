require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const chequeRoutes = require('./routes/cheque');
console.log('Attempting to connect with URI:', process.env.MONGO_URI);
const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // To parse JSON bodies
app.use('/uploads', express.static('uploads')); // Serve uploaded images statically

// Routes
app.use('/api/cheques', chequeRoutes);

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('MongoDB Connected...');
    // Start Server
    app.listen(PORT, () => console.log(`Backend server running on http://localhost:${PORT}`));
})
.catch(err => console.error(err));