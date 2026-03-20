import { dynamicsService } from '../src/services/dynamics.service';
import dotenv from 'dotenv';

dotenv.config();

async function testDynamics() {
    console.log('Testing Dynamics CRM Integration...');

    try {
        // 1. Test Authentication implicitly via search
        console.log('\n1. Testing Lookup (implicitly tests Auth)...');

        // Testing with user provided number: 0832852913
        const testPhone = '0832852913';
        const result = await dynamicsService.getContactByPhone(testPhone);

        console.log('Lookup Result:', result ? `Found ${result.type}: ${result.fullname}` : 'No contact found (Expected if number not in DB)');

        // 2. Test Logging
        console.log('\n2. Testing Message Logging...');
        // We can try to log even if contact is null (it should just log with no regarding object)
        await dynamicsService.logMessage(
            result,
            'This is a test message from the verification script',
            'Incoming',
            testPhone
        );

        console.log('Logging completed (Check logs for any errors)');

    } catch (error) {
        console.error('Test Failed:', error);
    }
}

testDynamics();
