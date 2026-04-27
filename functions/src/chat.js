const functions = require('firebase-functions');
const admin = require('firebase-admin');

exports.onNewMessage = functions.firestore
  .document('chats/{chatId}/messages/{msgId}')
  .onCreate(async (snap, context) => {
    const message = snap.data();
    const chatId = context.params.chatId;
    
    // Get chat doc to find receiver
    const chatDoc = await admin.firestore().collection('chats').doc(chatId).get();
    if (!chatDoc.exists) return null;
    
    const participants = chatDoc.data().participants || [];
    const receiverId = participants.find(id => id !== message.senderId);
    if (!receiverId) return null;
    
    // Get receiver FCM token
    const receiverDoc = await admin.firestore().collection('users').doc(receiverId).get();
    if (!receiverDoc.exists) return null;
    
    const token = receiverDoc.data().fcmToken;
    if (!token) return null;

    const senderName = message.senderName || 'A Farmer';
    
    // Build notification payload
    const notification = {
      title: senderName,
      body: message.type === 'voice' 
        ? '🎤 Sent a voice message' 
        : (message.translatedText || message.text),
      sound: 'default'
    };

    const payload = {
      notification: notification,
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        type: 'chat',
        chatId: chatId,
      }
    };

    // Send FCM
    try {
      await admin.messaging().sendToDevice(token, payload);
      console.log(`Notification sent to ${receiverId} for chat ${chatId}`);
    } catch (error) {
      console.error('Error sending chat push notification:', error);
    }
    
    return null;
  });
