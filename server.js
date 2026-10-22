import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure public/uploads directory exists automatically
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `item-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Configure Nodemailer Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { 
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    }
});

// HTML Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'home.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/marketplace', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/seller', (req, res) => res.sendFile(path.join(__dirname, 'views', 'seller.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

// Direct Image Upload Endpoint
app.post('/api/upload-image', upload.single('itemImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
    }
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, imageUrl });
});

// SMTP Diagnostic Verification Route
app.get('/api/test-email', async (req, res) => {
    try {
        await transporter.verify();
        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: 'BID PARK - SMTP Test Email',
            text: 'Your Nodemailer configuration is active and working properly!'
        });
        res.json({ success: true, message: `Test email successfully sent to ${process.env.EMAIL_USER}`, messageId: info.messageId });
    } catch (err) {
        console.error("❌ SMTP Test Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');

async function startServer() {
    try {
        await client.connect();
        const db = client.db(process.env.DB_NAME || 'auctiondb');
        console.log("✅ MongoDB Connected to BID PARK");

        // User Registration & Password Hashing
        app.post('/api/register', async (req, res) => {
            const { name, email, password, role, adminCode } = req.body;

            if (role === 'admin' && adminCode !== (process.env.ADMIN_SECRET || 'ADM1N')) {
                return res.status(403).json({ error: 'Invalid Admin Passcode!' });
            }

            const existingUser = await db.collection('users').findOne({ email });
            if (existingUser) return res.status(400).json({ error: 'User already exists' });

            const hashedPassword = await bcrypt.hash(password, 10);
            await db.collection('users').insertOne({ 
                name, 
                email, 
                password: hashedPassword, 
                role: role || 'customer', 
                createdAt: new Date() 
            });

            // Welcome Email Dispatch
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email,
                subject: 'Welcome to BID PARK!',
                text: `Hi ${name},\n\nYour account has been successfully created on BID PARK as a ${role || 'customer'}.\n\nBest regards,\nBID PARK Team`
            }).catch(err => console.log('Welcome email dispatch skipped/failed:', err.message));

            res.json({ success: true, message: 'Account created successfully!' });
        });     

        // User Login
        app.post('/api/login', async (req, res) => {
            const { email, password } = req.body;
            const user = await db.collection('users').findOne({ email });
            if (!user) return res.status(400).json({ error: 'Invalid email or password' });

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

            res.json({ success: true, user: { name: user.name, email: user.email, role: user.role } });
        });

        // Password Reset
        app.post('/api/change-password', async (req, res) => {
            const { email, currentPassword, newPassword } = req.body;
            const user = await db.collection('users').findOne({ email });
            if (!user) return res.status(404).json({ error: 'User not found' });

            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) return res.status(400).json({ error: 'Incorrect current password' });

            const newHashedPassword = await bcrypt.hash(newPassword, 10);
            await db.collection('users').updateOne({ email }, { $set: { password: newHashedPassword } });
            res.json({ success: true, message: 'Password updated successfully!' });
        });

        // Real-Time Socket.io Handling
        io.on('connection', (socket) => {
            socket.on('getItems', async () => {
                const items = await db.collection('auctions').find().toArray();
                socket.emit('initItems', items);
            });

            // Submit New Item
            socket.on('submitItem', async (itemData) => {
                const randomSeed = encodeURIComponent(itemData.name.replace(/\s+/g, '-') + '-' + Date.now());
                const listingTime = new Date();

                const newItem = {
                    name: itemData.name,
                    description: itemData.description || 'No detailed description provided.',
                    startingPrice: parseInt(itemData.startingPrice),
                    currentPrice: parseInt(itemData.startingPrice),
                    image: itemData.image || `https://picsum.photos/seed/${randomSeed}/300/200`,
                    sellerEmail: itemData.sellerEmail,
                    highestBidder: 'None',
                    highestBidderEmail: 'None',
                    status: 'active',
                    createdAt: listingTime
                };

                await db.collection('auctions').insertOne(newItem);
                const updatedItems = await db.collection('auctions').find().toArray();
                io.emit('initItems', updatedItems);
            });

            // Place Real-Time Bid
            socket.on('placeBid', async (bidData) => {
                const { itemId, amount, userName, userEmail } = bidData;
                await db.collection('auctions').updateOne(
                    { _id: new ObjectId(itemId) },
                    { $set: { currentPrice: amount, highestBidder: userName, highestBidderEmail: userEmail } }
                );
                io.emit('bidUpdated', { itemId, amount, userName });
            });

            // Admin: Close Auction (With Verbose Email Diagnostics)
            socket.on('closeAuction', async (data) => {
                const { itemId } = data;
                try {
                    const item = await db.collection('auctions').findOne({ _id: new ObjectId(itemId) });
                    if (!item) return;

                    const endedAt = new Date();

                    await db.collection('auctions').updateOne(
                        { _id: new ObjectId(itemId) },
                        { $set: { status: 'completed', endedAt: endedAt } }
                    );

                    // Verify winner email exists and attempt dispatch
                    if (item.highestBidderEmail && item.highestBidderEmail !== 'None') {
                        console.log(`📧 Dispatching auction winner email to: ${item.highestBidderEmail}`);

                        const paymentLink = `${process.env.PAYMENT_GATEWAY_URL}?item=${item._id}&amount=${item.currentPrice}`;
                        
                        try {
                            const mailInfo = await transporter.sendMail({
                                from: `"BID PARK" <${process.env.EMAIL_USER}>`,
                                to: item.highestBidderEmail,
                                subject: `Congratulations! You Won the Auction on BID PARK: ${item.name}`,
                                html: `
                                    <div style="font-family: Arial, sans-serif; background: #121212; color: #ffffff; padding: 20px; border-radius: 8px;">
                                        <h2 style="color: #4caf50;">🎉 You Won the Auction!</h2>
                                        <p>Hi <strong>${item.highestBidder}</strong>,</p>
                                        <p>Your bid on <strong>${item.name}</strong> was successful at <strong>KES ${item.currentPrice.toLocaleString()}</strong>.</p>
                                        <p>Please click the button below to complete your order:</p>
                                        <a href="${paymentLink}" style="display: inline-block; padding: 12px 20px; background: #2196f3; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Complete Checkout</a>
                                    </div>
                                `
                            });
                            console.log(`✅ Email sent successfully! Message ID: ${mailInfo.messageId}`);
                        } catch (emailErr) {
                            console.error(`❌ Nodemailer Dispatch Failed: ${emailErr.message}`);
                        }
                    } else {
                        console.log(`⚠️ Email skipped: Highest bidder email address is 'None'.`);
                    }

                    const updatedItems = await db.collection('auctions').find().toArray();
                    io.emit('initItems', updatedItems);
                    io.emit('auctionClosedNotification', { itemId, winner: item.highestBidder });
                } catch (err) {
                    console.error("Failed to close auction:", err.message);
                }
            });
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => console.log(`🚀 BID PARK System Live at http://localhost:${PORT}`));

    } catch (err) {
        console.error("Database connection failed:", err);
    }
}

startServer();