## Chat
1. Give me testcase related login
2. Give me testcase related login with priority High
3. please what Test Environments support for app ? does it support windows ?
4. what are functional requirements area ?

## Test Plan 
1. Please generate test plan based attached documents
2. Act as a Senior QA Test Architect. Analyze the provided Product Requirements Document (PRD) and existing Test Plan. Create an updated Test Plan that:

Retains relevant existing test scenarios.
Adds new test scenarios based on PRD changes.
Identifies gaps, missing coverage, and obsolete tests.
Suggests risk-based, regression, integration, security, performance, accessibility, and usability test cases.
Recommends AI-friendly testing opportunities, including test automation, self-healing locators, AI-assisted test generation, test data generation, visual validation, API contract validation, and production monitoring.
Highlight edge cases, negative scenarios, and high-priority areas.


## TestCase Generator

1. Refer to the existing Login Test Cases and update them based on the following requirement:

When a user enters an email with the domain @google.com or @microsoft.com:
Password field should be disabled.
Sign In button should display the corresponding Google or Microsoft logo.
Clicking the Sign In button should redirect the user to the respective SSO authentication screen.
For all other email domains, existing username/password login behavior should remain unchanged.

Generate:

New test cases.
Updated existing test cases.
Positive, negative, boundary, UI, accessibility, security, and cross-browser scenarios.
API and integration validation scenarios.
Automation candidates and risk-based test recommendations.
Missing edge cases and validation gaps.


please create end to end testcase 
Search product, click product, add to cart then checkout 


Script

TC: Verify Login with Valid Credential
1. Launch App
2. Click Sign In button
3. Verify redirect "https://bstackdemo.com/signin"
4. Select Username
5. Select password
6. Click Login button
7. Verify "https://bstackdemo.com/?signin=true" 
8. Header should have Logout button


TC: Verify Search Product
1. Launch App
2. Click Sign In button
3. Verify redirect "https://bstackdemo.com/signin"
4. Select Username
5. Select password
6. Click Login button
7. Verify "https://bstackdemo.com/?signin=true" 
8. Header should have Logout button
9. Click Search Product
10. Search "Iphone"
11. User should see match iphone in product list

TC: Verify Sauce Demo Product Search
1. Launch App "https://sauce-demo.myshopify.com/"
2. Click Search Product
3. Search "Grey"
4. User should see match iphone in product list




TC: Verify Amazon Product Search
1. Launch App "https://www.amazon.in/"
2. Click Search Product
3. Search "Ipone 17"
4. User should see match iphone in product list

TC: Verify Flipkart Product Search
1. Launch App "https://www.flipkart.com/"
2. Click Search Product
3. Search "Ipone 17"
4. User should see match iphone in product list


TC: Verify Myntra Product Search
1. Launch App "https://www.myntra.com/"
2. Click Search Product
3. Search "Tshirt"
4. User should see match tshirt in product list
5. Click First Tshirt Product 
6. Click Checkout
7. Add to Cart
import { test, expect } from '@playwright/test';

test('test login', async ({ page }) => {
  await page.goto('https://bstackdemo.com/');
  await page.getByRole('link', { name: 'Sign In' }).click();
  await page.locator('div').filter({ hasText: /^Select Username$/ }).nth(2).click();
  await page.getByText('image_not_loading_user', { exact: true }).click();
  await page.locator('div').filter({ hasText: /^Select Password$/ }).nth(2).click();
  await page.getByText('testingisfun99', { exact: true }).click();
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByRole('link', { name: 'Logout' })).toBeVisible();
  await page.getByRole('link', { name: 'Logout' }).click();
  await expect(page.getByRole('link', { name: 'Sign In' })).toBeVisible();
  await expect(page.locator('#signin')).toContainText('Sign In');
   await page.waitForTimeout(5000);
});

i want you to create explain.md

in that file

i want you demonstrate project 

feature - document
what is use of it ?
why did you built it  and problem it solve?


TechStack Used 
Where we store docs and How we fetch docs 
why and How we use Neo DB for documents feature
what is rag used and How we used rag 
you can make diagram to explain 
what our ingestion diagram and pipeline does work
what our retrival diagram and pipeline does work
working with step by step 

Note - I dont want essay for each point i want simple and on point explain which is explaining to interviewer

Similary for other features Like Test Plan Generator, Test Case Generator, Test Script Generator, Test Runner 
