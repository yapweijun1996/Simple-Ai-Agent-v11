/**
 * ./js/app.js
 * Main Application Module - Entry point for the application
 * Coordinates initialization of all other modules
 */
const App = (function() {
    'use strict';
    
    // Debug logger for App
    function debugLog(...args) {
        console.log('[App]', ...args);
    }

    // Private state
    let loginModal = null;

    /**
     * Initializes the application
     */
    function init() {
        debugLog('init - starting application initialization');
        // Initialize UI controller
        UIController.init();
        
        // Load saved settings from cookie
        const savedSettings = Utils.getSettingsFromCookie() || {};
        
        // Initialize settings controller with saved settings
        SettingsController.init();
        
        // Initialize chat controller with settings
        ChatController.init(savedSettings);
        
        // Show main container (will be visible but login modal on top)
        document.getElementById('chat-container').style.display = 'flex';
        
        // Check for saved password
        debugLog('init - checking for saved password');
        checkPasswordOrPrompt();
    }

    /**
     * Checks for a saved password or prompts the user
     */
    function checkPasswordOrPrompt() {
        debugLog('checkPasswordOrPrompt - retrieving saved password');
        const savedPassword = Utils.getPasswordFromCookie();
        
        if (savedPassword) {
            debugLog('checkPasswordOrPrompt - found saved password, attempting login');
            doLogin(savedPassword);
        } else {
            debugLog('checkPasswordOrPrompt - no saved password, showing login modal');
            showLoginModal();
        }
    }
    
    /**
     * Creates and shows the login modal
     */
    function showLoginModal() {
        debugLog('showLoginModal - displaying login modal');
        if (!loginModal) {
            // Create login modal from template
            loginModal = Utils.createFromTemplate('login-modal-template');
            document.body.appendChild(loginModal);
            
            // Setup event listeners
            document.getElementById('login-button').addEventListener('click', handleLogin);
            document.getElementById('api-password').addEventListener('keydown', function(event) {
                if (event.key === 'Enter') {
                    handleLogin();
                }
            });
            
            // Focus the password input
            setTimeout(() => {
                document.getElementById('api-password').focus();
            }, 100);
        }
        
        loginModal.style.display = 'flex';
        document.getElementById('login-error').style.display = 'none';
    }
    
    /**
     * Handles login form submission
     */
    function handleLogin() {
        debugLog('handleLogin - user submitted login form');
        const passwordInput = document.getElementById('api-password');
        const rememberCheckbox = document.getElementById('remember-password');
        const password = passwordInput.value.trim();
        
        if (!password) {
            document.getElementById('login-error').textContent = 'Password is required.';
            document.getElementById('login-error').style.display = 'block';
            return;
        }
        
        const success = ApiService.init(password);
        
        if (success) {
            debugLog('handleLogin - password correct, login successful');
            // Store remember password setting
            const settings = ChatController.getSettings();
            settings.rememberPassword = rememberCheckbox.checked;
            ChatController.updateSettings(settings);
            
            // Save password if remember is checked
            if (rememberCheckbox.checked) {
                Utils.savePasswordToCookie(password);
            }
            
            // Hide the login modal
            loginModal.style.display = 'none';
        } else {
            debugLog('handleLogin - password incorrect, showing error');
            // Show error message
            document.getElementById('login-error').textContent = 'Invalid password. Please try again.';
            document.getElementById('login-error').style.display = 'block';
            Utils.clearSavedPassword();
            passwordInput.value = '';
            passwordInput.focus();
        }
    }
    
    /**
     * Attempts to login with the provided password
     * @param {string} password - The API key password
     */
    function doLogin(password) {
        debugLog('doLogin - attempting login with saved password');
        const success = ApiService.init(password);
        
        if (!success) {
            debugLog('doLogin - saved password invalid, clearing and prompting');
            Utils.clearSavedPassword();
            showLoginModal();
        }
    }
    
    /**
     * Logs the user out by clearing saved credentials
     */
    function logOut() {
        debugLog('logOut - clearing credentials and reloading');
        Utils.clearSavedPassword();
        location.reload();
    }

    // Initialize the app when the DOM is ready
    window.addEventListener('DOMContentLoaded', function() {
        debugLog('DOMContentLoaded event - calling init');
        init();
    });
    
    // Public API
    return {
        init,
        logOut
    };
})();

// The app will auto-initialize when the DOM is loaded 