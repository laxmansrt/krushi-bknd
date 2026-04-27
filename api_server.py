import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.server_api import ServerApi
from urllib.parse import quote_plus

app = Flask(__name__)
# Enable CORS so our frontend can call this backend
CORS(app)

# Safely encode the password because it contains an '@' symbol
USER = 'laxmanmegalamani5_db_user'
PASSWORD = quote_plus('Laxman@8055')
URI = f'mongodb+srv://{USER}:{PASSWORD}@cluster0.v4vpih0.mongodb.net/?appName=Cluster0'

# Initialize MongoDB Client
client = MongoClient(URI, server_api=ServerApi('1'))
db = client['krishirent']
equipment_collection = db['equipment']

@app.route('/api/equipment', methods=['POST'])
def add_equipment():
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        # Insert into MongoDB
        result = equipment_collection.insert_one(data)
        
        return jsonify({
            'message': 'Equipment listed successfully',
            'inserted_id': str(result.inserted_id)
        }), 201

    except Exception as e:
        print(f"Error inserting into MongoDB: {e}")
        return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    print("🚀 KrishiRent API Server running on http://127.0.0.1:5000")
    print("Connecting to MongoDB Atlas...")
    app.run(host='0.0.0.0', port=5000)
